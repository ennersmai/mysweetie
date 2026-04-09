const axios = require('axios');

async function testTts() {
  const UNREALSPEECH_API_KEY = process.env.UNREALSPEECH_API_KEY;
  if (!UNREALSPEECH_API_KEY) {
    console.error("UNREALSPEECH_API_KEY is not set in your environment.");
    return;
  }

  const url = 'https://api.v8.unrealspeech.com/stream';
  const data = {
    "Text": "Hello, this is a test.",
    "VoiceId": "Scarlett"
  };

  try {
    console.log("Sending request to Unreal Speech...");
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Bearer ${UNREALSPEECH_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    console.log('Request successful! Status:', response.status);
    // You can pipe the stream to a file to test it
    // response.data.pipe(fs.createWriteStream('test.mp3'));
  } catch (error) {
    console.error('Error making TTS request:', error.response ? error.response.data : error.message);
  }
}

testTts();
