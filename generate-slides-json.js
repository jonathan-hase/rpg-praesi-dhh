const fs = require('fs');
const path = require('path');

const slidesDir = path.join(__dirname, 'slides');
const outputFile = path.join(__dirname, 'slides.json');

const imageExtensions = ['.webp', '.avif', '.jpg', '.jpeg', '.png'];

function isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return imageExtensions.includes(ext);
}

function getImagesInFolder(folderPath) {
    try {
        return fs.readdirSync(folderPath)
            .filter(file => {
                const fullPath = path.join(folderPath, file);
                return fs.statSync(fullPath).isFile() && isImageFile(file);
            })
            .sort(); // Sort alphabetically for consistent order
    } catch (error) {
        return [];
    }
}

function calculateGridDimensions(imageCount) {
    // Calculate optimal grid dimensions
    if (imageCount <= 1) return { columns: 1, rows: 1 };
    if (imageCount <= 4) return { columns: 2, rows: 2 };
    if (imageCount <= 6) return { columns: 3, rows: 2 };
    if (imageCount <= 9) return { columns: 3, rows: 3 };
    if (imageCount <= 12) return { columns: 4, rows: 3 };
    return { columns: 4, rows: Math.ceil(imageCount / 4) };
}

try {
    const entries = fs.readdirSync(slidesDir);
    const slides = [];

    // Sort entries to maintain consistent order
    entries.sort();

    for (const entry of entries) {
        const fullPath = path.join(slidesDir, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            // It's a folder - create a grid slide
            const images = getImagesInFolder(fullPath);

            if (images.length > 0) {
                const { columns, rows } = calculateGridDimensions(images.length);

                slides.push({
                    type: 'grid',
                    folder: `slides/${entry}`,
                    images: images.map(img => `slides/${entry}/${img}`),
                    columns: columns,
                    rows: rows
                });

                console.log(`  Grid slide: ${entry}/ (${images.length} images, ${columns}x${rows})`);
            }
        } else if (isImageFile(entry)) {
            // It's a single image file
            slides.push(`slides/${entry}`);
            console.log(`  Single slide: ${entry}`);
        }
    }

    fs.writeFileSync(outputFile, JSON.stringify(slides, null, 2));
    console.log(`\nGenerated slides.json with ${slides.length} slides`);
} catch (error) {
    console.error('Error generating slides.json:', error);
    process.exit(1);
}
