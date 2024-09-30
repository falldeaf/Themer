const express = require('express');
const fs = require('fs-extra');
const cron = require('node-cron');
const Ajv = require('ajv');
const path = require('path');

const app = express();
const port = 3100;
let settings = require('./settings/profiles.json');

// Volatile objects to store tasks, plugins, and latest generations
let tasks = {}; // Store the cron task functions
let plugins = {}; // Store the image generation plugin methods
let latestGenerations = {}; // Store the latest generations for each profile and action
let enumState = {}; // Helper to store randomization state

//image generation plugins
Object.keys(settings).forEach(key => {
		const plugin_name = settings[key].plugin;
		const plugin = require(`./plugins/${plugin_name}`);
		plugins[plugin_name] = plugin.getImage;
});

const settings_file = path.join(__dirname, 'settings/profiles.json');

// Load schema from a separate file
const ajv = new Ajv();
const schema = fs.readJsonSync(path.join(__dirname, 'schema.json'));
const validate = ajv.compile(schema);

// Function to validate top-level settings objects
function validateSettings(newSettings) {
	//Loop through the top level objects (profiles), get the key and object value from the settings file
	Object.keys(newSettings).forEach(key => {
		const valid = validate(newSettings[key]);
		if (valid) {
			console.log(`Validation successful for ${key}`);
		} else {
			console.log(`Validation Error for ${key}:`, validate.errors);
			return false;
		}
	});

	return true;
}

// Start or restart cron tasks for all top-level objects
function startCronTasks() {

	// Stop any existing tasks
	Object.keys(tasks).forEach(key => {
		if (tasks[key]) tasks[key].stop();
	});

	// validate the settings file
	if (!validateSettings(settings)) {
		console.log('Invalid settings, cron tasks not started.');
		return;
	} else {
		console.log('Settings are valid.');
	}

	// For each top-level object, start a cron task if active
	Object.keys(settings).forEach(key => {
		console.log(`Setting up cron task for ${key}...`);
		const config = settings[key];
		if (config.active) {
			console.log(`Cron schedule: ${config.cron}`);
			tasks[key] = cron.schedule(config.cron, () => {
				console.log(`Running cron task for ${key}...`);
				runCronTask(config);
			});
		}
	});
}
startCronTasks();

async function runCronTask(config) {
	let image_params = await compileInputString(config);

	latestGenerations[config.name] = {...image_params, date: new Date()};

	// Run actions for the given config
	for (const action of config.actions) {

		//check if this action is active
		if (!action.active) {
			continue;
		}

		const image_gen = await plugins[config.plugin](image_params.description, action.resolution);

		if(image_gen.success) {
			if (!latestGenerations[config.name]) latestGenerations[config.name] = {};
			latestGenerations[config.name][action.name] = {url: image_gen.url, color: action.color};
		}
	}
}

// Function to shuffle an array (Fisher-Yates shuffle)
function shuffleArray(array) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

// Randomization handlers
const randomizationSchemes = {
	incremental: (enumData, tag, configName) => {
		// Initialize the state for the profile and tag if it doesn't exist
		if (!enumState[configName]) enumState[configName] = {};
		if (!enumState[configName].incremental) enumState[configName].incremental = {};
		if (!enumState[configName].incremental[tag]) enumState[configName].incremental[tag] = 0;

		// Get the next item in the list
		const currentIndex = enumState[configName].incremental[tag];
		const selectedItem = enumData.options[currentIndex];

		// Increment the index, resetting if needed
		enumState[configName].incremental[tag] = (currentIndex + 1) % enumData.options.length;

		return selectedItem;
	},

	random: (enumData) => {
		const randomIndex = Math.floor(Math.random() * enumData.options.length);
		return enumData.options[randomIndex];
	},

	perceived: (enumData, tag, configName) => {
		// Initialize state for the profile and tag if it doesn't exist
		if (!enumState[configName]) enumState[configName] = {};
		if (!enumState[configName].perceivedRandom) enumState[configName].perceivedRandom = {};
		if (!enumState[configName].perceivedRandom[tag]) enumState[configName].perceivedRandom[tag] = [];

		const history = enumState[configName].perceivedRandom[tag];
		let candidate;

		// Try to pick an item that hasn't been used recently
		do {
			candidate = Math.floor(Math.random() * enumData.options.length);
		} while (history.includes(candidate) && history.length < enumData.options.length);

		// Add the candidate to history
		history.push(candidate);

		// Keep history limited to a certain size (e.g., last 2 items)
		if (history.length > 2) history.shift();

		return enumData.options[candidate];
	},

	shuffle: (enumData, tag, configName) => {
		if (!enumState[configName]) enumState[configName] = {};
		if (!enumState[configName].shuffleRandom) enumState[configName].shuffleRandom = {};
		if (!enumState[configName].shuffleRandom[tag]) {
			// First time: shuffle and set the state
			enumState[configName].shuffleRandom[tag] = shuffleArray([...enumData.options]);
		}

		// Get the current shuffled array for this tag
		const currentBag = enumState[configName].shuffleRandom[tag];

		// Pick the first item from the shuffled array
		const selectedItem = currentBag.shift();

		// If the shuffled array is empty, reshuffle and restart
		if (currentBag.length === 0) {
			enumState[configName].shuffleRandom[tag] = shuffleArray([...enumData.options]);
		}

		return selectedItem;
	}
};

// Default tag handlers, now with randomization scheme per enum
const defaultTagHandlers = {
	defaultHandler: (tag, config) => {
		const enumData = config.enums[tag];  // Get the enum data
		if (enumData && enumData.options.length > 0) {
			// Use the enum's randomization type
			const scheme = enumData.random || 'jsRandom';  // Default to jsRandom if not specified
			const handler = randomizationSchemes[scheme] || randomizationSchemes.jsRandom;
			return handler(enumData, tag, config.name);  // Pass in the config.name for unique profile state
		} else {
			return `{{${tag}}}`;  // No match, return original placeholder
		}
	},

	// Handler for dark mode
	darkmode: (tag, config) => (config.darkmode ? 'dark' : 'light')
};
const customTagHandlers = require('./settings/tagHandlers');  // Import custom tag handlers
const tagHandlers = { ...defaultTagHandlers, ...customTagHandlers };  // Custom handlers override defaults

// Function to compile the input string with custom handlers
async function compileInputString(config) {
	let compiledString = config.inputstring;
	let final_object = {};

	// Find all tags in the input string
	const tagMatches = [...compiledString.matchAll(/{{(\w+)}}/g)];

	// Replace each tag with the result of the appropriate handler
	for (const match of tagMatches) {
		const tag = match[1];
		const handler = tagHandlers[tag] || tagHandlers.defaultHandler;

		// Process the handler asynchronously if needed
		let replacement;
		if (handler.constructor.name === 'AsyncFunction') {
			replacement = await handler(tag, config);  // Await if it's an async handler
		} else {
			replacement = handler(tag, config);  // Handle synchronously
			final_object[tag] = replacement;
		}

		// Replace the tag in the compiled string
		compiledString = compiledString.replace(match[0], replacement);
	}

	final_object.description = compiledString;
	return final_object
}

// Watch for changes in the settings.json file
fs.watch(settings_file, async (eventType, filename) => {

	console.log(`Event type is: ${eventType}`);

	if (eventType === 'change') {
		console.log(`${filename} has changed. Reloading...`);
		try {
			const newSettings = await fs.readJson(settings_file);
			settings = newSettings;
			startCronTasks();

		} catch (err) {
			console.error('Error reading or parsing settings.json:', err);
		}
	}
});

// front-end route (/public/index.html)
app.use(express.static('public'));

// Routes to view the current settings
app.get('/settings', (req, res) => {
	res.json(settings);
});

// Routes to view the latest generations
app.get('/latest', (req, res) => {
	res.json(latestGenerations);
});

// Routes to view the latest generations for a specific profile and action
app.get('/latest/:profile/:action', (req, res) => {
	const profile = req.params.profile;
	const action = req.params.action;
	if (latestGenerations[profile] && latestGenerations[profile][action]) {
		res.json(latestGenerations[profile][action]);
	} else {
		res.status(404).send('Not found');
	}
});

app.listen(port, () => {
	console.log(`Server running at http://localhost:${port}`);
});
