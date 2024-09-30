require('dotenv').config({ path: './settings/.env' });
const model = "V_2";
const aspectRatios = {
		"16:9": "ASPECT_16_9",
		"4:3": "ASPECT_4_3",
		"9:16": "ASPECT_9_16"
};

async function getImage(prompt, aspect_ratio) {

	console.log(`Generating ideogram image with description: ${prompt} aspect ratio: ${aspect_ratio} ( ${aspectRatios[aspect_ratio]} )`);
	return {success: true, url: "https://tempurl.com/" + aspect_ratio};

	console.log(`api key: ${process.env.IDEOGRAM_API_KEY}`);

	const url = 'https://api.ideogram.ai/generate';
	const options = {
	method: 'POST',
	headers: {'Api-Key': process.env.IDEOGRAM_API_KEY, 'Content-Type': 'application/json'},
	body: `{"image_request":{"prompt":"${prompt}","aspect_ratio":"${aspectRatios[aspect_ratio]}","model":"V_2","magic_prompt_option":"AUTO"}}`
	};

	try {
		const response = await fetch(url, options);
		const data = await response.json();
		console.log(data);
		return {success: true, url: data.data[0].url};
	} catch (error) {
		console.error(error);
		return {success: false, error: error};
	}
}

module.exports = {
	getImage
};
