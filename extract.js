const axios = require('axios');
const fs = require('fs');

axios.get('https://tenor.com/fr/view/peeking-danny-fenton-doctors-disorders-danny-phantom-anyone-home-gif-23883243').then(res => {
    const urls = [];
    const regex = /https:\/\/[^"']+\.(mp4|gif)/gi;
    let match;
    while ((match = regex.exec(res.data)) !== null) {
        urls.push(match[0]);
    }
    console.log(Array.from(new Set(urls)).join('\n'));
});
