const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function downloadTenor() {
    try {
        const url = 'https://tenor.com/fr/view/danny-phantom-going-ghost-danny-fenton-danny-phantom-gif-6432173118659606372';
        console.log('Fetching page...');
        const res = await axios.get(url);
        
        // Find MP4 URL in meta tags
        const html = res.data;
        const mp4Match = html.match(/<meta\s+content="([^"]+\.mp4)"\s+property="og:video"/i) || 
                         html.match(/content="([^"]+\.mp4)"\s+property="og:video"/i) || 
                         html.match(/<meta\s+property="og:video"\s+content="([^"]+\.mp4)"/i);
        
        let mediaUrl = null;
        let ext = '.mp4';
        
        if (mp4Match) {
            mediaUrl = mp4Match[1];
        } else {
            // fallback to GIF
            const gifMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+\.gif)"/i) || 
                             html.match(/content="([^"]+\.gif)"\s+property="og:image"/i);
            if (gifMatch) {
                mediaUrl = gifMatch[1];
                ext = '.gif';
            }
        }
        
        if (!mediaUrl) {
            console.log('Could not find media URL in HTML');
            return;
        }
        
        console.log('Found media URL:', mediaUrl);
        const mediaRes = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        
        const imgDir = path.join(__dirname, 'img');
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir);
        
        const outPath = path.join(imgDir, 'on_anim' + ext);
        fs.writeFileSync(outPath, mediaRes.data);
        console.log('Saved to', outPath);
    } catch(e) {
        console.log('Error:', e.message);
    }
}
downloadTenor();
