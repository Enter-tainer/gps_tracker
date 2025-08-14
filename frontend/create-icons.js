const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Create a simple GPS icon using SVG and convert to PNG
const svgIcon = `
  <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
    <rect width="512" height="512" fill="#2563eb" rx="80"/>
    <circle cx="256" cy="256" r="180" fill="white"/>
    <circle cx="256" cy="256" r="120" fill="#2563eb"/>
    <circle cx="256" cy="256" r="40" fill="white"/>
    <path d="M256 80 L256 120 M256 392 L256 432 M80 256 L120 256 M392 256 L432 256" stroke="white" stroke-width="20"/>
    <path d="M256 160 L256 352 M160 256 L352 256" stroke="#2563eb" stroke-width="8"/>
  </svg>`;

async function createIcons() {
  const iconsDir = path.join(__dirname, 'public', 'icons');
  
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  try {
    // Create 192x192 icon
    await sharp(Buffer.from(svgIcon))
      .resize(192, 192)
      .png()
      .toFile(path.join(iconsDir, 'icon-192.png'));

    // Create 512x512 icon
    await sharp(Buffer.from(svgIcon))
      .resize(512, 512)
      .png()
      .toFile(path.join(iconsDir, 'icon-512.png'));

    // Create apple touch icon (180x180)
    await sharp(Buffer.from(svgIcon))
      .resize(180, 180)
      .png()
      .toFile(path.join(iconsDir, 'apple-touch-icon-180x180.png'));

    // Create favicon (32x32)
    await sharp(Buffer.from(svgIcon))
      .resize(32, 32)
      .png()
      .toFile(path.join(iconsDir, 'favicon.ico'));

    console.log('✅ PWA icons created successfully!');
    console.log('- icon-192.png (192x192)');
    console.log('- icon-512.png (512x512)');
    console.log('- apple-touch-icon-180x180.png (180x180)');
    console.log('- favicon.ico (32x32)');
  } catch (error) {
    console.error('Error creating icons:', error);
  }
}

createIcons();