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

        // Slide dimensions will be determined from loaded images
        this.slideWidth = 0;
        this.slideHeight = 0;

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
            await this.loadCurrentSlides();
            await this.setupCanvas();
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
        const updateSize = () => {
            const dpi = window.devicePixelRatio || 1;

            // Use the aspect ratio from the loaded slide
            // If slideWidth/slideHeight are not set yet, they will be set after loading first slide
            if (this.slideWidth > 0 && this.slideHeight > 0) {
                const slideAspect = this.slideWidth / this.slideHeight;

                // 10px gap on all sides
                const gap = 10;
                const maxWidth = window.innerWidth - (gap * 2);
                const maxHeight = window.innerHeight - (gap * 2);

                let displayWidth, displayHeight;
                if (maxWidth / maxHeight > slideAspect) {
                    // Height-constrained
                    displayHeight = maxHeight;
                    displayWidth = displayHeight * slideAspect;
                } else {
                    // Width-constrained
                    displayWidth = maxWidth;
                    displayHeight = displayWidth / slideAspect;
                }

                this.slideWidth = displayWidth;
                this.slideHeight = displayHeight;
            }

            this.canvas.width = window.innerWidth * dpi;
            this.canvas.height = window.innerHeight * dpi;
            this.canvas.style.width = `${window.innerWidth}px`;
            this.canvas.style.height = `${window.innerHeight}px`;
        };

        updateSize();
        window.addEventListener('resize', updateSize);
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

        // Set slide dimensions from first loaded image
        if (this.slideWidth === 0 || this.slideHeight === 0) {
            this.slideWidth = textureData.width;
            this.slideHeight = textureData.height;
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
        this.currentSlideIndex++;

        if (this.currentSlideIndex >= this.slides.length) {
            // Loop back to start
            this.currentSlideIndex = 0;
        }

        this.saveProgress();
        await this.loadCurrentSlides();
        this.render();
    }

    createTransformMatrix(offsetX, offsetY, scale, rotationDeg, depth) {
        const rad = (rotationDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Create transformation matrix
        const aspectRatio = this.canvas.width / this.canvas.height;
        const slideAspect = this.slideWidth / this.slideHeight;

        const scaleX = (this.slideWidth / this.canvas.width) * 2 * scale;
        const scaleY = (this.slideHeight / this.canvas.height) * 2 * scale;

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

                this.renderSlide(
                    this.nextTextures[i],
                    offset,
                    -offset,
                    scale,
                    0,
                    depth,
                    opacity,
                    passEncoder
                );
            }
        }

        // Render current slide (with throw animation if active)
        if (this.currentTexture) {
            let offsetX = 0;
            let offsetY = 0;
            let rotation = 0;
            let opacity = 1.0;

            if (this.isAnimating) {
                const eased = 1 - Math.pow(1 - this.animationProgress, 3);
                offsetX = this.throwDirection.x * eased;
                offsetY = this.throwDirection.y * eased;
                rotation = this.throwRotation * eased;
                opacity = 1.0 - this.animationProgress;
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
