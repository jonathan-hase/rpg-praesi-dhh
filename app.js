// Slide Presentation Application with WebGPU
class SlidePresentation {
    constructor() {
        this.canvas = document.getElementById('slideCanvas');
        this.loadingEl = document.getElementById('loading');
        this.errorEl = document.getElementById('error');

        this.slides = [];
        this.currentSlideIndex = 0;
        this.isAnimating = false;
        this.animationProgress = 0;
        this.throwDirection = { x: 0, y: 0 };
        this.throwRotation = 0;

        // Original slide dimensions from loaded images (never changes)
        this.originalSlideWidth = 0;
        this.originalSlideHeight = 0;
        // Display dimensions (recalculated on resize)
        this.displayWidth = 0;
        this.displayHeight = 0;

        // Next slide random positioning
        this.nextSlideRotation = 0;
        this.nextSlideOffsetX = 0;
        this.nextSlideOffsetY = 0;

        // WebGPU resources
        this.device = null;
        this.context = null;
        this.pipeline = null;
        this.textureCache = new Map();
        this.currentTexture = null;
        this.nextTextures = [];

        this.init();
    }

    async init() {
        try {
            await this.checkWebGPU();
            await this.loadSlideList();
            await this.initWebGPU();
            this.loadProgress();
            this.setupCanvas();
            await this.loadCurrentSlides();
            // Generate initial random position for next slide
            this.generateNextSlidePosition();
            // Update canvas size now that we have slide dimensions
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
        // Load the list of all slide files
        const response = await fetch('slides.json');
        if (!response.ok) {
            throw new Error('Failed to load slide list. Please ensure slides.json exists.');
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

            // Use the aspect ratio from the original loaded slide
            if (this.originalSlideWidth > 0 && this.originalSlideHeight > 0) {
                const slideAspect = this.originalSlideWidth / this.originalSlideHeight;

                // 10px gap on all sides
                const gap = 10;
                const maxWidth = window.innerWidth - (gap * 2);
                const maxHeight = window.innerHeight - (gap * 2);

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

    loadProgress() {
        const saved = this.getCookie('slideProgress');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                this.currentSlideIndex = state.current;

                // Validate the saved state
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
        this.setCookie('slideProgress', JSON.stringify(state), 365);
    }

    async loadCurrentSlides() {
        // Load current slide
        const currentSlidePath = this.slides[this.currentSlideIndex];
        const textureData = await this.loadTexture(currentSlidePath);
        this.currentTexture = textureData.texture;

        // Set original slide dimensions from first loaded image (never changes)
        if (this.originalSlideWidth === 0 || this.originalSlideHeight === 0) {
            this.originalSlideWidth = textureData.width;
            this.originalSlideHeight = textureData.height;
        }

        // Load next few slides for the stack effect
        this.nextTextures = [];
        const slidesToPreload = Math.min(5, this.getRemainingSlides());

        for (let i = 1; i <= slidesToPreload; i++) {
            const idx = this.currentSlideIndex + i;
            if (idx < this.slides.length) {
                const slidePath = this.slides[idx];
                const textureData = await this.loadTexture(slidePath);
                this.nextTextures.push(textureData.texture);
            }
        }
    }

    generateNextSlidePosition() {
        // Random rotation between -15 and 15 degrees
        this.nextSlideRotation = (Math.random() - 0.5) * 30;
        // Random offset X between -0.2 and 0.2
        this.nextSlideOffsetX = (Math.random() - 0.5) * 0.4;
        // Random offset Y between -0.2 and 0.2
        this.nextSlideOffsetY = (Math.random() - 0.5) * 0.4;
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

    getRemainingSlides() {
        return this.slides.length - this.currentSlideIndex;
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

    throwSlide() {
        this.isAnimating = true;
        this.animationProgress = 0;

        // Random throw direction
        const angle = Math.random() * Math.PI * 2;
        const distance = 2.5 + Math.random() * 0.5;
        this.throwDirection = {
            x: Math.cos(angle) * distance,
            y: Math.sin(angle) * distance
        };

        // Random rotation direction
        this.throwRotation = (Math.random() - 0.5) * 720; // -360 to 360 degrees

        this.animateThrow();
    }

    animateThrow() {
        const duration = 500; // ms
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            this.animationProgress = Math.min(elapsed / duration, 1);

            // Ease out cubic
            const eased = 1 - Math.pow(1 - this.animationProgress, 3);

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

        // Save the old "next" slide position before loading new slides
        const oldNextRotation = this.nextSlideRotation;
        const oldNextOffsetX = this.nextSlideOffsetX;
        const oldNextOffsetY = this.nextSlideOffsetY;

        this.currentSlideIndex++;

        if (this.currentSlideIndex >= this.slides.length) {
            // Loop back to start
            this.currentSlideIndex = 0;
        }

        this.saveProgress();
        await this.loadCurrentSlides();

        // Restore the old values so the animation can use them
        // (what was "next" is now "current" and should animate from old position)
        this.nextSlideRotation = oldNextRotation;
        this.nextSlideOffsetX = oldNextOffsetX;
        this.nextSlideOffsetY = oldNextOffsetY;

        // Reset throw direction to signal we're in slide-in mode, not throw mode
        this.throwDirection = { x: 0, y: 0 };
        this.throwRotation = 0;

        // Start animation of old "next" slide moving to center
        this.isAnimating = true;
        this.animationProgress = 0;
        this.animateNextSlideToCenter();
    }

    animateNextSlideToCenter() {
        const duration = 500; // ms
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            this.animationProgress = Math.min(elapsed / duration, 1);

            this.render();

            if (this.animationProgress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Animation complete, generate new random position for the actual new next slide
                this.isAnimating = false;
                this.generateNextSlidePosition();
                this.render();
            }
        };

        requestAnimationFrame(animate);
    }

    createTransformMatrix(offsetX, offsetY, scale, rotationDeg, depth) {
        const rad = (rotationDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Create transformation matrix
        // Use display dimensions (in CSS pixels) and convert to normalized device coordinates
        const scaleX = (this.displayWidth / window.innerWidth) * scale;
        const scaleY = (this.displayHeight / window.innerHeight) * scale;

        return new Float32Array([
            cos * scaleX, sin * scaleX, 0, 0,
            -sin * scaleY, cos * scaleY, 0, 0,
            0, 0, 1, 0,
            offsetX, offsetY, depth, 1
        ]);
    }

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

        // Render stack of next slides (from back to front)
        const remaining = this.getRemainingSlides();
        const maxStack = 5;
        const stackSize = Math.min(maxStack, remaining - 1);

        for (let i = stackSize - 1; i >= 0; i--) {
            if (i < this.nextTextures.length) {
                const depth = -0.5 - (i * 0.05);
                const offset = (stackSize - i) * 3;
                const scale = 0.95 + (i * 0.01);

                // Calculate visibility: fully visible until last few slides
                let opacity = 1.0;
                if (remaining <= maxStack) {
                    const slidePosition = stackSize - i;
                    if (slidePosition >= remaining - 1) {
                        opacity = 0.0;
                    }
                }

                let slideOffsetX = offset;
                let slideOffsetY = -offset;
                let slideRotation = 0;

                // First slide in stack (next slide) has special animated positioning
                if (i === 0 && this.nextTextures.length > 0) {
                    const baseBrightness = 0.6; // 40% darkened

                    if (this.isAnimating) {
                        // Animate from random rotated/offset/dark position to neutral
                        const eased = 1 - Math.pow(1 - this.animationProgress, 3);
                        slideRotation = this.nextSlideRotation * (1 - eased);
                        slideOffsetX = this.nextSlideOffsetX * (1 - eased);
                        slideOffsetY = this.nextSlideOffsetY * (1 - eased);
                        // Animate brightness from dark to full
                        const brightness = baseBrightness + (1.0 - baseBrightness) * eased;
                        opacity *= brightness;
                    } else {
                        // Static position: randomly rotated, offset, and darkened
                        slideRotation = this.nextSlideRotation;
                        slideOffsetX = this.nextSlideOffsetX;
                        slideOffsetY = this.nextSlideOffsetY;
                        opacity *= baseBrightness;
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

        // Render current slide (with throw animation or slide-in animation)
        if (this.currentTexture) {
            let offsetX = 0;
            let offsetY = 0;
            let rotation = 0;
            let opacity = 1.0;

            if (this.isAnimating) {
                const eased = 1 - Math.pow(1 - this.animationProgress, 3);

                // Check if we're in throw mode or slide-in mode
                if (this.throwDirection.x !== 0 || this.throwDirection.y !== 0) {
                    // Throw animation: current slide flying away
                    offsetX = this.throwDirection.x * eased;
                    offsetY = this.throwDirection.y * eased;
                    rotation = this.throwRotation * eased;
                    opacity = 1.0 - this.animationProgress;
                } else {
                    // Slide-in animation: new current slide (was next) moving to center
                    const baseBrightness = 0.6; // 40% darkened
                    offsetX = this.nextSlideOffsetX * (1 - eased);
                    offsetY = this.nextSlideOffsetY * (1 - eased);
                    rotation = this.nextSlideRotation * (1 - eased);
                    const brightness = baseBrightness + (1.0 - baseBrightness) * eased;
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

        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
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

    // Cookie utilities
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

// Initialize the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new SlidePresentation());
} else {
    new SlidePresentation();
}
