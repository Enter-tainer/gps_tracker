const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

// Simple text-based icons since canvas might not be available
const createIcon = (size) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Background
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(0, 0, size, size);
  
  // GPS icon - circle with crosshair
  const center = size / 2;
  const radius = size * 0.35;
  
  // White circle background
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, 2 * Math.PI);
  ctx.fill();
  
  // Blue inner circle
  ctx.fillStyle = '#2563eb';
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.6, 0, 2 * Math.PI);
  ctx.fill();
  
  // White center dot
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.2, 0, 2 * Math.PI);
  ctx.fill();
  
  // Crosshair lines
  ctx.strokeStyle = 'white';
  ctx.lineWidth = size * 0.04;
  
  // Horizontal line
  ctx.beginPath();
  ctx.moveTo(center - radius * 0.8, center);
  ctx.lineTo(center + radius * 0.8, center);
  ctx.stroke();
  
  // Vertical line
  ctx.beginPath();
  ctx.moveTo(center, center - radius * 0.8);
  ctx.lineTo(center, center + radius * 0.8);
  ctx.stroke();
  
  return canvas.toBuffer('image/png');
};

// Generate icons
try {
  const iconsDir = path.join(__dirname, 'public', 'icons');
  
  // Create 192x192 icon
  const icon192 = createIcon(192);
  fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), icon192);
  console.log('Created icon-192.png');
  
  // Create 512x512 icon
  const icon512 = createIcon(512);
  fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), icon512);
  console.log('Created icon-512.png');
  
  console.log('Icons generated successfully!');
} catch (error) {
  console.error('Error generating icons:', error.message);
  
  // Fallback: create simple text files as placeholders
  console.log('Creating placeholder icon files...');
  
  const placeholderIcon = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#2563eb"/>
  <circle cx="256" cy="256" r="180" fill="white"/>
  <circle cx="256" cy="256" r="100" fill="#2563eb"/>
  <text x="256" y="280" font-family="Arial" font-size="60" text-anchor="middle" fill="white">GPS</text>
</svg>`;
  
  fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'icon-192.png'), 
    Buffer.from(placeholderIcon.replace('512', '192')));
  fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'icon-512.png'), 
    Buffer.from(placeholderIcon));
  
  console.log('Placeholder icons created as SVG files');
}