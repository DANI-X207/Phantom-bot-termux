const axios = require('axios');
async function test() {
    const prompt = 'A dynamic action battle between Naruto and Goku';
    try {
        const pollRes = await axios.get(\https://image.pollinations.ai/prompt/\?width=1024&height=1024&nologo=true\, { responseType: 'arraybuffer', timeout: 60000 });
        console.log('Pollinations Success, buffer size:', pollRes.data.length);
    } catch(e) {
        console.error('Pollinations Error:', e.message);
    }
}
test();
