// Card Study Application with WebGPU
class CardStudyApp {
    constructor() {
        this.canvas = document.getElementById('cardCanvas');
        this.loadingEl = document.getElementById('loading');
        this.errorEl = document.getElementById('error');

        this.cards = [];
        this.currentCardIndex = 0;
        this.shuffledIndices = [];
        this.isAnimating = false;
        this.animationProgress = 0;
        this.throwDirection = { x: 0, y: 0 };
        this.throwRotation = 0;

        // Card dimensions in mm
        this.cardWidthMM = 63;
        this.cardHeightMM = 88;

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
            await this.loadCardList();
            await this.initWebGPU();
            await this.setupCanvas();
            this.loadShuffleState();
            await this.loadCurrentCards();
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

    async loadCardList() {
        // Load the list of all card files
        const response = await fetch('cards.json');
        if (!response.ok) {
            throw new Error('Failed to load card list. Please ensure cards.json exists.');
        }
        this.cards = await response.json();

        if (this.cards.length === 0) {
            throw new Error('No cards found in the card list.');
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

            // Calculate card size in pixels (96 DPI = 1 inch = 25.4mm)
            const mmToPixel = (96 / 25.4) * dpi;
            const cardWidthPx = this.cardWidthMM * mmToPixel;
            const cardHeightPx = this.cardHeightMM * mmToPixel;

            // Ensure the card fits on screen with some margin
            const maxWidth = window.innerWidth * 0.9;
            const maxHeight = window.innerHeight * 0.9;

            let scale = 1;
            if (cardWidthPx > maxWidth || cardHeightPx > maxHeight) {
                scale = Math.min(maxWidth / cardWidthPx, maxHeight / cardHeightPx);
            }

            this.cardWidth = cardWidthPx * scale;
            this.cardHeight = cardHeightPx * scale;

            this.canvas.width = window.innerWidth * dpi;
            this.canvas.height = window.innerHeight * dpi;
            this.canvas.style.width = `${window.innerWidth}px`;
            this.canvas.style.height = `${window.innerHeight}px`;
        };

        updateSize();
        window.addEventListener('resize', updateSize);
    }

    loadShuffleState() {
        const saved = this.getCookie('cardStudyProgress');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                this.shuffledIndices = state.indices;
                this.currentCardIndex = state.current;

                // Validate the saved state
                if (this.shuffledIndices.length !== this.cards.length) {
                    throw new Error('Invalid saved state');
                }
            } catch (e) {
                this.resetShuffle();
            }
        } else {
            this.resetShuffle();
        }
    }

    saveShuffleState() {
        const state = {
            indices: this.shuffledIndices,
            current: this.currentCardIndex
        };
        this.setCookie('cardStudyProgress', JSON.stringify(state), 365);
    }

    resetShuffle() {
        // Create array of indices and shuffle
        this.shuffledIndices = Array.from({ length: this.cards.length }, (_, i) => i);
        this.fisherYatesShuffle(this.shuffledIndices);
        this.currentCardIndex = 0;
        this.saveShuffleState();
    }

    fisherYatesShuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    async loadCurrentCards() {
        // Load current card
        const currentCardPath = this.cards[this.shuffledIndices[this.currentCardIndex]];
        this.currentTexture = await this.loadTexture(currentCardPath);

        // Load next few cards for the stack effect
        this.nextTextures = [];
        const cardsToPreload = Math.min(5, this.getRemainingCards());

        for (let i = 1; i <= cardsToPreload; i++) {
            const idx = this.currentCardIndex + i;
            if (idx < this.shuffledIndices.length) {
                const cardPath = this.cards[this.shuffledIndices[idx]];
                const texture = await this.loadTexture(cardPath);
                this.nextTextures.push(texture);
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

        this.textureCache.set(path, texture);
        return texture;
    }

    getRemainingCards() {
        return this.shuffledIndices.length - this.currentCardIndex;
    }

    setupEventListeners() {
        const handleInteraction = (e) => {
            e.preventDefault();
            if (!this.isAnimating) {
                this.throwCard();
            }
        };

        this.canvas.addEventListener('click', handleInteraction);
        this.canvas.addEventListener('touchstart', handleInteraction, { passive: false });
    }

    throwCard() {
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
                this.onCardThrowComplete();
            }
        };

        requestAnimationFrame(animate);
    }

    async onCardThrowComplete() {
        this.isAnimating = false;
        this.currentCardIndex++;

        if (this.currentCardIndex >= this.shuffledIndices.length) {
            // Reshuffle
            this.resetShuffle();
        } else {
            this.saveShuffleState();
        }

        await this.loadCurrentCards();
        this.render();
    }

    createTransformMatrix(offsetX, offsetY, scale, rotationDeg, depth) {
        const rad = (rotationDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Create transformation matrix
        const aspectRatio = this.canvas.width / this.canvas.height;
        const cardAspect = this.cardWidth / this.cardHeight;

        const scaleX = (this.cardWidth / this.canvas.width) * 2 * scale;
        const scaleY = (this.cardHeight / this.canvas.height) * 2 * scale;

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

        // Render stack of next cards (from back to front)
        const remaining = this.getRemainingCards();
        const maxStack = 5;
        const stackSize = Math.min(maxStack, remaining - 1);

        for (let i = stackSize - 1; i >= 0; i--) {
            if (i < this.nextTextures.length) {
                const depth = -0.5 - (i * 0.05);
                const offset = (stackSize - i) * 3;
                const scale = 0.95 + (i * 0.01);

                // Calculate visibility: fully visible until last few cards
                let opacity = 1.0;
                if (remaining <= maxStack) {
                    const cardPosition = stackSize - i;
                    if (cardPosition >= remaining - 1) {
                        opacity = 0.0;
                    }
                }

                this.renderCard(
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

        // Render current card (with throw animation if active)
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

            this.renderCard(
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

    renderCard(texture, offsetX, offsetY, scale, rotation, depth, opacity, passEncoder) {
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
    document.addEventListener('DOMContentLoaded', () => new CardStudyApp());
} else {
    new CardStudyApp();
}
