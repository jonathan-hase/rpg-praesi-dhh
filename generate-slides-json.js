const fs = require('fs');
const path = require('path');

const slidesDir = path.join(__dirname, 'slides');
const outputFile = path.join(__dirname, 'slides.json');

try {
    const files = fs.readdirSync(slidesDir)
        .filter(file => file.endsWith('.webp'))
        .map(file => `slides/${file}`);

    fs.writeFileSync(outputFile, JSON.stringify(files, null, 2));
    console.log(`Generated slides.json with ${files.length} slides`);
} catch (error) {
    console.error('Error generating slides.json:', error);
    process.exit(1);
}
