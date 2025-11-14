// ============================================================================
// SLIDE PRESENTATION APPLICATION WITH WEBGPU
// ============================================================================

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    // Display & Layout
    WINDOW_GAP: 100, // Gap from window edges in pixels

    // Animation Timing
    THROW_DURATION: 500, // Duration of throw animation in ms
    SLIDE_IN_DURATION: 300, // Duration of slide-in animation in ms

    // Throw Animation
    THROW_DISTANCE_MIN: 2.5, // Minimum throw distance
    THROW_DISTANCE_RANGE: 0.5, // Additional random distance range
    THROW_ROTATION_RANGE: 720, // Rotation range (-360 to +360 degrees)

    // Next Slide Positioning
    NEXT_SLIDE_ROTATION_RANGE: 10, // Random rotation range (-15 to +15 degrees)
    NEXT_SLIDE_OFFSET_RANGE: 0.4, // Random offset range (-0.2 to +0.2)
    NEXT_SLIDE_BRIGHTNESS: 0.6, // Brightness for next slide (0.6 = 40% darkened)

    // Stack Effect
    MAX_STACK_SIZE: 5, // Maximum number of slides in stack
    STACK_DEPTH_OFFSET: 0.05, // Depth offset per slide in stack
    STACK_SCALE_INCREMENT: 0.01, // Scale increment per slide in stack
    STACK_BASE_SCALE: 0.95, // Base scale for stacked slides
    STACK_POSITION_OFFSET: 3, // Position offset multiplier for stack

    // Performance
    SLIDES_TO_PRELOAD: 5, // Number of slides to preload ahead

    // Storage
    COOKIE_EXPIRY_DAYS: 365, // Days until progress cookie expires
    PROGRESS_COOKIE_NAME: 'slideProgress',

    // Data Source
    SLIDES_JSON_PATH: 'slides.json',
};

// ============================================================================
// MAIN APPLICATION CLASS
// ============================================================================
class SlidePresentation {
    constructor() {
        // DOM Elements
        this.canvas = document.getElementById('slideCanvas');
        this.loadingEl = document.getElementById('loading');
        this.errorEl = document.getElementById('error');

        // Slide Data
        this.slides = [];
        this.currentSlideIndex = 0;

        // Animation State
        this.isAnimating = false;
        this.animationProgress = 0;
        this.throwDirection = { x: 0, y: 0 };
        this.throwRotation = 0;

        // Slide Dimensions
        this.originalSlideWidth = 0;  // Original image dimensions (never changes)
        this.originalSlideHeight = 0;
        this.displayWidth = 0;         // Display dimensions (recalculated on resize)
        this.displayHeight = 0;

        // Next Slide Positioning
        this.nextSlideRotation = 0;
        this.nextSlideOffsetX = 0;
        this.nextSlideOffsetY = 0;

        // WebGPU Resources
        this.device = null;
        this.context = null;
        this.pipeline = null;
        this.textureCache = new Map();
        this.currentTexture = null;
        this.nextTextures = [];

        this.init();
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    async init() {
        try {
            await this.checkWebGPU();
            await this.loadSlideList();
            await this.initWebGPU();
            this.loadProgress();
            this.setupCanvas();
            await this.loadCurrentSlides();
            this.generateNextSlidePosition();
            this.updateCanvasSize();
            this.setupEventListeners();
            this.loadingEl.style.display = 'none';
            this.render();
        } catch (error) {
            this.showError(error.message);
        }
    }

    async checkWebGPU() {
        if (!navigator.gpu) {
            throw new Error('WebGPU is not supported in your browser. Please use Chrome/Edge 113+ or another WebGPU-capable browser.');
        }
    }

    async loadSlideList() {
        const response = await fetch(CONFIG.SLIDES_JSON_PATH);
        if (!response.ok) {
            throw new Error(`Failed to load slide list. Please ensure ${CONFIG.SLIDES_JSON_PATH} exists.`);
        }
        this.slides = await response.json();

        if (this.slides.length === 0) {
            throw new Error('No slides found in the slide list.');
        }
    }

    async initWebGPU() {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('Failed to get WebGPU adapter');
        }

        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');

        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: presentationFormat,
            alphaMode: 'premultiplied',
        });

        await this.createPipeline(presentationFormat);
    }

    async createPipeline(format) {
        const shaderCode = `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) texCoord: vec2<f32>,
            }

            struct Uniforms {
                transform: mat4x4<f32>,
                opacity: f32,
                depth: f32,
            }

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            @group(0) @binding(1) var textureSampler: sampler;
            @group(0) @binding(2) var textureData: texture_2d<f32>;

            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 6>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(1.0, -1.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(-1.0, 1.0)
                );

                var texCoord = array<vec2<f32>, 6>(
                    vec2<f32>(0.0, 1.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(1.0, 0.0),
                    vec2<f32>(0.0, 1.0),
                    vec2<f32>(1.0, 0.0),
                    vec2<f32>(0.0, 0.0)
                );

                var output: VertexOutput;
                let transformed = uniforms.transform * vec4<f32>(pos[vertexIndex], uniforms.depth, 1.0);
                output.position = transformed;
                output.texCoord = texCoord[vertexIndex];
                return output;
            }

            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                let color = textureSample(textureData, textureSampler, input.texCoord);
                return vec4<f32>(color.rgb, color.a * uniforms.opacity);
            }
        `;

        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }

    setupCanvas() {
        this.updateCanvasSize = () => {
            const dpi = window.devicePixelRatio || 1;

            // Calculate display dimensions based on original slide aspect ratio
            if (this.originalSlideWidth > 0 && this.originalSlideHeight > 0) {
                const slideAspect = this.originalSlideWidth / this.originalSlideHeight;

                const maxWidth = window.innerWidth - (CONFIG.WINDOW_GAP * 2);
                const maxHeight = window.innerHeight - (CONFIG.WINDOW_GAP * 2);

                if (maxWidth / maxHeight > slideAspect) {
                    // Height-constrained
                    this.displayHeight = maxHeight;
                    this.displayWidth = this.displayHeight * slideAspect;
                } else {
                    // Width-constrained
                    this.displayWidth = maxWidth;
                    this.displayHeight = this.displayWidth / slideAspect;
                }
            }

            this.canvas.width = window.innerWidth * dpi;
            this.canvas.height = window.innerHeight * dpi;
            this.canvas.style.width = `${window.innerWidth}px`;
            this.canvas.style.height = `${window.innerHeight}px`;
        };

        this.updateCanvasSize();
        window.addEventListener('resize', () => {
            this.updateCanvasSize();
            if (this.currentTexture) {
                this.render();
            }
        });
    }

    setupEventListeners() {
        const handleInteraction = (e) => {
            e.preventDefault();
            if (!this.isAnimating) {
                this.throwSlide();
            }
        };

        this.canvas.addEventListener('click', handleInteraction);
        this.canvas.addEventListener('touchstart', handleInteraction, { passive: false });
    }

    // ========================================================================
    // SLIDE MANAGEMENT
    // ========================================================================

    async loadCurrentSlides() {
        // Load current slide texture
        const currentSlidePath = this.slides[this.currentSlideIndex];
        const textureData = await this.loadTexture(currentSlidePath);
        this.currentTexture = textureData.texture;

        // Store original slide dimensions from first loaded image
        if (this.originalSlideWidth === 0 || this.originalSlideHeight === 0) {
            this.originalSlideWidth = textureData.width;
            this.originalSlideHeight = textureData.height;
        }

        // Preload next slides for stack effect
        this.nextTextures = [];
        const slidesToPreload = Math.min(CONFIG.SLIDES_TO_PRELOAD, this.getRemainingSlides());

        for (let i = 1; i <= slidesToPreload; i++) {
            const idx = this.currentSlideIndex + i;
            if (idx < this.slides.length) {
                const slidePath = this.slides[idx];
                const textureData = await this.loadTexture(slidePath);
                this.nextTextures.push(textureData.texture);
            }
        }
    }

    async loadTexture(path) {
        if (this.textureCache.has(path)) {
            return this.textureCache.get(path);
        }

        const response = await fetch(path);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);

        const texture = this.device.createTexture({
            size: [imageBitmap.width, imageBitmap.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture: texture },
            [imageBitmap.width, imageBitmap.height]
        );

        const textureData = {
            texture: texture,
            width: imageBitmap.width,
            height: imageBitmap.height
        };

        this.textureCache.set(path, textureData);
        return textureData;
    }

    generateNextSlidePosition() {
        // Generate random rotation
        this.nextSlideRotation = (Math.random() - 0.5) * CONFIG.NEXT_SLIDE_ROTATION_RANGE;
        // Generate random offsets
        this.nextSlideOffsetX = (Math.random() - 0.5) * CONFIG.NEXT_SLIDE_OFFSET_RANGE;
        this.nextSlideOffsetY = (Math.random() - 0.5) * CONFIG.NEXT_SLIDE_OFFSET_RANGE;
    }

    getRemainingSlides() {
        return this.slides.length - this.currentSlideIndex;
    }

    // ========================================================================
    // PROGRESS MANAGEMENT
    // ========================================================================

    loadProgress() {
        const saved = this.getCookie(CONFIG.PROGRESS_COOKIE_NAME);
        if (saved) {
            try {
                const state = JSON.parse(saved);
                this.currentSlideIndex = state.current;

                // Validate saved state
                if (this.currentSlideIndex >= this.slides.length) {
                    this.currentSlideIndex = 0;
                }
            } catch (e) {
                this.currentSlideIndex = 0;
            }
        } else {
            this.currentSlideIndex = 0;
        }
    }

    saveProgress() {
        const state = {
            current: this.currentSlideIndex
        };
        this.setCookie(CONFIG.PROGRESS_COOKIE_NAME, JSON.stringify(state), CONFIG.COOKIE_EXPIRY_DAYS);
    }

    // ========================================================================
    // ANIMATION
    // ========================================================================

    throwSlide() {
        this.isAnimating = true;
        this.animationProgress = 0;

        // Generate random throw direction
        const angle = Math.random() * Math.PI * 2;
        const distance = CONFIG.THROW_DISTANCE_MIN + Math.random() * CONFIG.THROW_DISTANCE_RANGE;
        this.throwDirection = {
            x: Math.cos(angle) * distance,
            y: Math.sin(angle) * distance
        };

        // Generate random rotation
        this.throwRotation = (Math.random() - 0.5) * CONFIG.THROW_ROTATION_RANGE;

        this.animateThrow();
    }

    animateThrow() {
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            this.animationProgress = Math.min(elapsed / CONFIG.THROW_DURATION, 1);

            this.render();

            if (this.animationProgress < 1) {
                requestAnimationFrame(animate);
            } else {
                this.onSlideThrowComplete();
            }
        };

        requestAnimationFrame(animate);
    }

    async onSlideThrowComplete() {
        this.isAnimating = false;

        // Save old next slide position for animation
        const oldNextRotation = this.nextSlideRotation;
        const oldNextOffsetX = this.nextSlideOffsetX;
        const oldNextOffsetY = this.nextSlideOffsetY;

        // Advance to next slide
        this.currentSlideIndex++;
        if (this.currentSlideIndex >= this.slides.length) {
            this.currentSlideIndex = 0;
        }

        this.saveProgress();
        await this.loadCurrentSlides();

        // Restore old values for slide-in animation
        this.nextSlideRotation = oldNextRotation;
        this.nextSlideOffsetX = oldNextOffsetX;
        this.nextSlideOffsetY = oldNextOffsetY;

        // Reset throw direction to signal slide-in mode
        this.throwDirection = { x: 0, y: 0 };
        this.throwRotation = 0;

        // Start slide-in animation
        this.isAnimating = true;
        this.animationProgress = 0;
        this.animateSlideIn();
    }

    animateSlideIn() {
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            this.animationProgress = Math.min(elapsed / CONFIG.SLIDE_IN_DURATION, 1);

            this.render();

            if (this.animationProgress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Animation complete, generate new position for new next slide
                this.isAnimating = false;
                this.generateNextSlidePosition();
                this.render();
            }
        };

        requestAnimationFrame(animate);
    }

    // ========================================================================
    // RENDERING
    // ========================================================================

    render() {
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(this.pipeline);

        // Render stack of next slides (back to front)
        this.renderStack(passEncoder);

        // Render current slide with animation
        this.renderCurrentSlide(passEncoder);

        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    renderStack(passEncoder) {
        const remaining = this.getRemainingSlides();
        const stackSize = Math.min(CONFIG.MAX_STACK_SIZE, remaining - 1);

        for (let i = stackSize - 1; i >= 0; i--) {
            if (i < this.nextTextures.length) {
                const depth = -0.5 - (i * CONFIG.STACK_DEPTH_OFFSET);
                const offset = (stackSize - i) * CONFIG.STACK_POSITION_OFFSET;
                const scale = CONFIG.STACK_BASE_SCALE + (i * CONFIG.STACK_SCALE_INCREMENT);

                // Calculate visibility
                let opacity = 1.0;
                if (remaining <= CONFIG.MAX_STACK_SIZE) {
                    const slidePosition = stackSize - i;
                    if (slidePosition >= remaining - 1) {
                        opacity = 0.0;
                    }
                }

                let slideOffsetX = offset;
                let slideOffsetY = -offset;
                let slideRotation = 0;

                // Special positioning for next slide (first in stack)
                if (i === 0 && this.nextTextures.length > 0) {
                    if (this.isAnimating) {
                        // Animate from random position to neutral (only during slide-in)
                        if (this.throwDirection.x === 0 && this.throwDirection.y === 0) {
                            const eased = 1 - Math.pow(1 - this.animationProgress, 3);
                            slideRotation = this.nextSlideRotation * (1 - eased);
                            slideOffsetX = this.nextSlideOffsetX * (1 - eased);
                            slideOffsetY = this.nextSlideOffsetY * (1 - eased);
                            const brightness = CONFIG.NEXT_SLIDE_BRIGHTNESS + (1.0 - CONFIG.NEXT_SLIDE_BRIGHTNESS) * eased;
                            opacity *= brightness;
                        } else {
                            // During throw, keep next slide at its position
                            slideRotation = this.nextSlideRotation;
                            slideOffsetX = this.nextSlideOffsetX;
                            slideOffsetY = this.nextSlideOffsetY;
                            opacity *= CONFIG.NEXT_SLIDE_BRIGHTNESS;
                        }
                    } else {
                        // Static position: rotated, offset, and darkened
                        slideRotation = this.nextSlideRotation;
                        slideOffsetX = this.nextSlideOffsetX;
                        slideOffsetY = this.nextSlideOffsetY;
                        opacity *= CONFIG.NEXT_SLIDE_BRIGHTNESS;
                    }
                }

                this.renderSlide(
                    this.nextTextures[i],
                    slideOffsetX,
                    slideOffsetY,
                    scale,
                    slideRotation,
                    depth,
                    opacity,
                    passEncoder
                );
            }
        }
    }

    renderCurrentSlide(passEncoder) {
        if (!this.currentTexture) return;

        let offsetX = 0;
        let offsetY = 0;
        let rotation = 0;
        let opacity = 1.0;

        if (this.isAnimating) {
            const eased = 1 - Math.pow(1 - this.animationProgress, 3);

            if (this.throwDirection.x !== 0 || this.throwDirection.y !== 0) {
                // Throw animation: current slide flying away
                offsetX = this.throwDirection.x * eased;
                offsetY = this.throwDirection.y * eased;
                rotation = this.throwRotation * eased;
                opacity = 1.0 - this.animationProgress;
            } else {
                // Slide-in animation: new current slide moving to center
                offsetX = this.nextSlideOffsetX * (1 - eased);
                offsetY = this.nextSlideOffsetY * (1 - eased);
                rotation = this.nextSlideRotation * (1 - eased);
                const brightness = CONFIG.NEXT_SLIDE_BRIGHTNESS + (1.0 - CONFIG.NEXT_SLIDE_BRIGHTNESS) * eased;
                opacity = brightness;
            }
        }

        this.renderSlide(
            this.currentTexture,
            offsetX,
            offsetY,
            1.0,
            rotation,
            0,
            opacity,
            passEncoder
        );
    }

    renderSlide(texture, offsetX, offsetY, scale, rotation, depth, opacity, passEncoder) {
        const sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        const transformMatrix = this.createTransformMatrix(offsetX, offsetY, scale, rotation, depth);

        const uniformBuffer = this.device.createBuffer({
            size: 80, // mat4x4 (64 bytes) + float (4) + float (4) + padding
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const uniformData = new Float32Array(20);
        uniformData.set(transformMatrix, 0);
        uniformData[16] = opacity;
        uniformData[17] = depth;

        this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        const bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: sampler },
                { binding: 2, resource: texture.createView() },
            ],
        });

        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(6, 1, 0, 0);
    }

    createTransformMatrix(offsetX, offsetY, scale, rotationDeg, depth) {
        const rad = (rotationDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Convert to normalized device coordinates
        const scaleX = (this.displayWidth / window.innerWidth) * scale;
        const scaleY = (this.displayHeight / window.innerHeight) * scale;

        return new Float32Array([
            cos * scaleX, sin * scaleX, 0, 0,
            -sin * scaleY, cos * scaleY, 0, 0,
            0, 0, 1, 0,
            offsetX, offsetY, depth, 1
        ]);
    }

    // ========================================================================
    // UTILITY METHODS
    // ========================================================================

    setCookie(name, value, days) {
        const expires = new Date();
        expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
        document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/`;
    }

    getCookie(name) {
        const nameEQ = name + "=";
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
            let c = ca[i];
            while (c.charAt(0) === ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
        }
        return null;
    }

    showError(message) {
        this.loadingEl.style.display = 'none';
        this.errorEl.textContent = message;
        this.errorEl.style.display = 'block';
        console.error(message);
    }
}

// ============================================================================
// APPLICATION INITIALIZATION
// ============================================================================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new SlidePresentation());
} else {
    new SlidePresentation();
}
