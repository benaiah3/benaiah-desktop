import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

/*
 * Compact Benaiah living voice orb.
 * Shader motion adapted from ElevenLabs UI's MIT-licensed Orb component:
 * https://github.com/elevenlabs/ui
 * Copyright (c) 2025 Eleven Labs Inc. See public/vendor/elevenlabs-ui/LICENSE.md.
 */

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = `
  precision highp float;

  uniform float uTime;
  uniform float uAnimation;
  uniform float uDark;
  uniform float uInputVolume;
  uniform float uOutputVolume;
  uniform float uOpacity;
  uniform float uOffsets[7];
  varying vec2 vUv;

  const float PI = 3.14159265358979323846;

  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }

  float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float n = mix(
      mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0)), f - vec2(1.0)), u.x),
      u.y
    );
    return 0.5 + 0.5 * n;
  }

  float flow(vec3 decomposed, float time) {
    float first = noise2D(vec2(decomposed.x * 5.0 + time * 0.7, time * 0.35));
    float second = noise2D(vec2(decomposed.y * 5.0 - time * 0.55, time * 0.42 + 7.0));
    return mix(first, second, decomposed.z);
  }

  float noisyRing(vec3 decomposed, float time, float scale, float width) {
    float first = noise2D(vec2(decomposed.x, time) * scale);
    float second = noise2D(vec2(decomposed.y, time) * scale);
    float noise = (mix(first, second, decomposed.z) - 0.5) * 2.5;
    return 0.92 + noise * width;
  }

  bool drawOval(vec2 polarUv, float a, float b, bool reverseGradient, out vec4 ovalColor) {
    float oval = (polarUv.x * polarUv.x) / (a * a) + (polarUv.y * polarUv.y) / (b * b);
    float edge = smoothstep(1.0, 0.38, oval);
    if (edge <= 0.0) return false;
    float gradient = reverseGradient
      ? 1.0 - (polarUv.x / a + 1.0) * 0.5
      : (polarUv.x / a + 1.0) * 0.5;
    gradient = mix(0.5, gradient, 0.16);
    ovalColor = vec4(vec3(gradient), 0.86 * edge);
    return true;
  }

  vec3 colorRamp(float value, vec3 a, vec3 b, vec3 c, vec3 d) {
    if (value < 0.33) return mix(a, b, value * 3.0);
    if (value < 0.66) return mix(b, c, (value - 0.33) * 3.0);
    return mix(c, d, (value - 0.66) * 3.0);
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    float radius = length(uv);
    if (radius > 1.03) discard;

    float theta = atan(uv.y, uv.x);
    if (theta < 0.0) theta += 2.0 * PI;
    vec3 decomposed = vec3(
      theta / (2.0 * PI),
      mod(theta / (2.0 * PI) + 0.5, 1.0) + 1.0,
      abs(theta / PI - 1.0)
    );

    float flowingNoise = flow(decomposed, radius * 0.1 - uAnimation * 0.22) - 0.5;
    theta += flowingNoise * mix(0.1, 0.34, uOutputVolume);

    vec4 color = vec4(1.0);
    float originalCenters[7];
    originalCenters[0] = 0.0;
    originalCenters[1] = 0.5 * PI;
    originalCenters[2] = 1.0 * PI;
    originalCenters[3] = 1.5 * PI;
    originalCenters[4] = 2.0 * PI;
    originalCenters[5] = 2.5 * PI;
    originalCenters[6] = 3.0 * PI;

    for (int index = 0; index < 7; index++) {
      float center = originalCenters[index] + 0.52 * sin(uTime / 20.0 + uOffsets[index]);
      float shapeNoise = noise2D(vec2(mod(center + uTime * 0.045, 1.0) * 5.0, 2.4));
      float a = 0.5 + shapeNoise * 0.3;
      float b = max(0.12, shapeNoise * mix(3.5, 2.35, uInputVolume));
      float distanceTheta = min(abs(theta - center), min(abs(theta + 2.0 * PI - center), abs(theta - 2.0 * PI - center)));
      vec4 ovalColor;
      bool reverseGradient = (index == 1 || index == 3 || index == 5);
      if (drawOval(vec2(distanceTheta, radius), a, b, reverseGradient, ovalColor)) {
        color.rgb = mix(color.rgb, ovalColor.rgb, ovalColor.a);
      }
    }

    float ringOne = noisyRing(decomposed, uTime * 0.1, 5.0, 0.38);
    float ringTwo = noisyRing(decomposed.yxz, uTime * 0.08 + 2.7, 6.0, 0.24);
    float inputRadiusOne = radius + uInputVolume * 0.2;
    float inputRadiusTwo = radius + uInputVolume * 0.15;
    float ringAlphaOne = inputRadiusTwo >= ringOne ? mix(0.16, 0.62, uInputVolume) : 0.0;
    float ringAlphaTwo = smoothstep(ringTwo - 0.05, ringTwo + 0.05, inputRadiusOne) * mix(0.12, 0.46, uInputVolume);
    float totalRingAlpha = max(ringAlphaOne, ringAlphaTwo);
    color.rgb = 1.0 - (1.0 - color.rgb) * (1.0 - vec3(totalRingAlpha));

    vec3 darkA = vec3(0.015);
    vec3 darkB = vec3(0.18);
    vec3 darkC = vec3(0.72);
    vec3 darkD = vec3(1.0);
    vec3 lightA = vec3(0.0);
    vec3 lightB = vec3(0.012);
    vec3 lightC = vec3(0.13);
    vec3 lightD = vec3(0.48);
    vec3 rampA = mix(lightA, darkA, uDark);
    vec3 rampB = mix(lightB, darkB, uDark);
    vec3 rampC = mix(lightC, darkC, uDark);
    vec3 rampD = mix(lightD, darkD, uDark);
    color.rgb = colorRamp(color.r, rampA, rampB, rampC, rampD);

    float sphereZ = sqrt(max(0.0, 1.0 - min(radius, 1.0) * min(radius, 1.0)));
    vec3 normal = normalize(vec3(uv * 0.88, sphereZ));
    vec3 lightDirection = normalize(vec3(-0.55, 0.72, 1.0));
    float diffuse = max(0.0, dot(normal, lightDirection));
    float highlight = pow(diffuse, 10.0) * mix(0.08, 0.34, uDark);
    color.rgb *= 0.64 + diffuse * 0.48;
    color.rgb += vec3(highlight);

    float edge = smoothstep(1.025, 0.965, radius);
    float innerGlow = smoothstep(1.0, 0.7, radius) * 0.1 * uOutputVolume;
    color.rgb += vec3(innerGlow * uDark);
    gl_FragColor = vec4(color.rgb, edge * uOpacity);
  }
`

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)

  if (!shader) {
    throw new Error('Unable to create voice-orb shader')
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Voice-orb shader compilation failed'
    gl.deleteShader(shader)
    throw new Error(message)
  }

  return shader
}

function seededOffsets() {
  let value = 0xb3a1a4 | 0

  const random = () => {
    value = (value + 0x9e3779b9) | 0
    let mixed = value ^ (value >>> 16)
    mixed = Math.imul(mixed, 0x21f0aaad)
    mixed ^= mixed >>> 15
    mixed = Math.imul(mixed, 0x735a2d97)

    return ((mixed ^ (mixed >>> 15)) >>> 0) / 4294967296
  }

  return new Float32Array(Array.from({ length: 7 }, () => random() * Math.PI * 2))
}

export function JuniorGenieOrb({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    if (navigator.userAgent.includes('jsdom')) {
      setFallback(true)

      return
    }

    let gl: WebGLRenderingContext | null = null

    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: 'low-power'
      })
    } catch {
      setFallback(true)

      return
    }

    if (!gl) {
      setFallback(true)

      return
    }

    let frame = 0
    let resizeObserver: ResizeObserver | undefined
    let themeObserver: MutationObserver | undefined
    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null
    let vertex: WebGLShader | null = null
    let fragment: WebGLShader | null = null

    try {
      program = gl.createProgram()

      if (!program) {
        throw new Error('Unable to create voice-orb program')
      }

      vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
      fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
      gl.attachShader(program, vertex)
      gl.attachShader(program, fragment)
      gl.linkProgram(program)

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Unable to link voice-orb program')
      }

      const position = gl.getAttribLocation(program, 'aPosition')

      const uniforms = Object.fromEntries(
        ['uTime', 'uAnimation', 'uDark', 'uInputVolume', 'uOutputVolume', 'uOpacity', 'uOffsets'].map(name => [
          name,
          gl!.getUniformLocation(program!, name)
        ])
      )

      const offsets = seededOffsets()
      buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      gl.useProgram(program)
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

      const resize = () => {
        const bounds = canvas.getBoundingClientRect()
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const width = Math.max(1, Math.round(bounds.width * ratio))
        const height = Math.max(1, Math.round(bounds.height * ratio))

        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }

        gl!.viewport(0, 0, width, height)
      }

      let time = 0
      let animation = 0.1
      let output = 0.26
      let opacity = 0
      let lastFrameAt = 0
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

      const draw = () => {
        gl!.useProgram(program)
        gl!.uniform1f(uniforms.uTime, time)
        gl!.uniform1f(uniforms.uAnimation, animation)
        // Keep the site's intentionally inverted pairing: silver in light,
        // deep metallic black in dark.
        gl!.uniform1f(uniforms.uDark, document.documentElement.classList.contains('dark') ? 0 : 1)
        gl!.uniform1f(uniforms.uInputVolume, 0.04)
        gl!.uniform1f(uniforms.uOutputVolume, output)
        gl!.uniform1f(uniforms.uOpacity, opacity)
        gl!.uniform1fv(uniforms.uOffsets, offsets)
        gl!.clearColor(0, 0, 0, 0)
        gl!.clear(gl!.COLOR_BUFFER_BIT)
        gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4)
      }

      const loop = (now: number) => {
        const delta = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0.016
        lastFrameAt = now
        opacity = Math.min(1, opacity + delta * 2.4)
        output += (0.28 + Math.sin(time * 0.84) * 0.04 - output) * 0.14

        if (!reduceMotion.matches) {
          time += delta * 0.5
          animation += delta * (0.1 + (1 - Math.pow(output - 1, 2)) * 0.9)
        }

        draw()
        frame = requestAnimationFrame(loop)
      }

      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(canvas)
      themeObserver = new MutationObserver(draw)
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      resize()
      frame = requestAnimationFrame(loop)
    } catch (error) {
      console.warn('BENAIAH_ORB_WEBGL_UNAVAILABLE', error)
      setFallback(true)
    }

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      themeObserver?.disconnect()

      if (program) {
        gl.deleteProgram(program)
      }

      if (buffer) {
        gl.deleteBuffer(buffer)
      }

      if (vertex) {
        gl.deleteShader(vertex)
      }

      if (fragment) {
        gl.deleteShader(fragment)
      }
    }
  }, [])

  return (
    <span
      aria-hidden="true"
      className={cn('junior-genie-orb', fallback && 'is-fallback', className)}
      data-testid="junior-genie-orb"
    >
      <canvas className="junior-genie-orb-canvas" ref={canvasRef} />
    </span>
  )
}
