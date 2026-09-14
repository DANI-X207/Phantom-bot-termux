const zlib = require('zlib');
const path = require('path');
const terminalMain = require.resolve('qrcode-terminal');
const vendorDir = path.join(path.dirname(terminalMain), '..', 'vendor');
const QRCode = require(path.join(vendorDir, 'QRCode'));
const QRErrorCorrectLevel = require(path.join(vendorDir, 'QRCode', 'QRErrorCorrectLevel'));

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
}

// Génère un PNG monochrome autonome, sans service externe ni dépendance supplémentaire.
function toBuffer(text, { scale = 8, margin = 4 } = {}) {
    const qr = new QRCode(-1, QRErrorCorrectLevel.M);
    qr.addData(text);
    qr.make();

    const modules = qr.modules;
    const moduleCount = qr.getModuleCount();
    const size = (moduleCount + margin * 2) * scale;
    const raw = Buffer.alloc((size + 1) * size);

    for (let y = 0; y < size; y++) {
        const rowOffset = y * (size + 1);
        raw[rowOffset] = 0; // filtre PNG "None"
        for (let x = 0; x < size; x++) {
            const mx = Math.floor(x / scale) - margin;
            const my = Math.floor(y / scale) - margin;
            const black = mx >= 0 && my >= 0 && mx < moduleCount && my < moduleCount && modules[my][mx];
            raw[rowOffset + 1 + x] = black ? 0 : 255;
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;  // 8 bits par pixel
    header[9] = 0;  // niveaux de gris

    return Buffer.concat([
        Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

module.exports = { toBuffer };
