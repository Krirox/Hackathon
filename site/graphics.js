function enhanceGraphic(element, setup) {
  if (!element || element.hidden || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    setup();
  } catch {
    element.hidden = true;
  }
}

function initMatrixBackground() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'high-performance' }) ||
             canvas.getContext('experimental-webgl');

  if (!gl) {
    canvas.hidden = true;
    return;
  }
  const vsSource = `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  const fsSource = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform float u_alpha_factor;

    void main() {
      vec2 coord = gl_FragCoord.xy;
      vec2 uv = coord / u_resolution;
      float spacing = 9.0;
      vec2 cell = floor(coord / spacing);
      vec2 local = fract(coord / spacing) - vec2(0.5);
      float dist = length(local);

      float hash = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
      float radius = 0.16 + hash * 0.07;
      float dotMask = smoothstep(radius, radius - 0.08, dist);

      float field = 0.22 + hash * 0.18;
      float vigDist = length((uv - vec2(0.5, 0.42)) * vec2(1.05, 1.2));
      vec3 bgDark = vec3(0.067, 0.067, 0.067);
      vec3 bgCenter = vec3(0.125, 0.125, 0.125);
      vec3 bgColor = mix(bgCenter, bgDark, smoothstep(0.12, 0.92, vigDist));

      float mouseDist = length(coord - u_mouse);
      float aura = 0.0;
      if (mouseDist < 240.0) {
        aura = (1.0 - (mouseDist / 240.0)) * u_alpha_factor;
      }

      float dotAlpha = (field + aura * 0.55) * u_alpha_factor;
      vec3 dotColor = mix(vec3(0.42, 0.42, 0.43), vec3(0.86, 0.86, 0.87), hash);

      vec3 finalColor = mix(bgColor, dotColor, dotMask * dotAlpha);
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) {
    canvas.hidden = true;
    return;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(program));
    canvas.hidden = true;
    return;
  }
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1,
  ]), gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, 'a_position');
  const resLoc = gl.getUniformLocation(program, 'u_resolution');
  const timeLoc = gl.getUniformLocation(program, 'u_time');
  const mouseLoc = gl.getUniformLocation(program, 'u_mouse');
  const alphaLoc = gl.getUniformLocation(program, 'u_alpha_factor');

  let mouseX = -1000;
  let mouseY = -1000;

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resLoc, canvas.width, canvas.height);
    gl.uniform1f(timeLoc, 0);
    gl.uniform2f(mouseLoc, mouseX, mouseY);
    gl.uniform1f(alphaLoc, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  canvas.addEventListener('webglcontextlost', () => { canvas.hidden = true; });
  window.addEventListener('resize', () => enhanceGraphic(canvas, draw), { passive: true });
  window.addEventListener('pointermove', (event) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    mouseX = event.clientX * dpr;
    mouseY = (window.innerHeight - event.clientY) * dpr;
    enhanceGraphic(canvas, draw);
  }, { passive: true });
  draw();
}

function init3DStage() {
  const container = document.getElementById('canvas-3d-container');
  if (!container || typeof THREE === 'undefined') return;
  if (container.dataset.stageReady) return;
  container.dataset.stageReady = '1';
  let width = container.clientWidth || 480;
  let height = container.clientHeight || 480;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 1000);
  camera.position.set(0, 0.2, 14.2);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  function createEllipse(radiusX, radiusY, color, opacity) {
    const points = [];
    const segments = 160;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(theta) * radiusX, Math.sin(theta) * radiusY, 0));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity
    });
    return new THREE.LineLoop(geom, mat);
  }

  const ringMesh1 = createEllipse(5.1, 1.85, 0xe8e8e8, 0.42);
  ringMesh1.userData = { layerId: 3, name: 'Coordination Surface', base: 0.42 };
  const ringMesh2 = createEllipse(4.15, 1.55, 0xd0d0d0, 0.5);
  ringMesh2.userData = { layerId: 2, name: 'Cognitive Router', base: 0.5 };
  const ringMesh3 = createEllipse(3.2, 1.22, 0xf4f4f4, 0.72);
  ringMesh3.userData = { layerId: 1, name: 'Reality Ledger', base: 0.72 };

  const pivot1 = new THREE.Group();
  pivot1.rotation.set(1.12, 0.18, 0.42);
  pivot1.add(ringMesh1);

  const pivot2 = new THREE.Group();
  pivot2.rotation.set(0.95, -0.55, -0.28);
  pivot2.add(ringMesh2);

  const pivot3 = new THREE.Group();
  pivot3.rotation.set(1.05, 0.72, 0.18);
  pivot3.add(ringMesh3);

  const orbit1 = createEllipse(5.55, 2.05, 0xbdbdbd, 0.22);
  orbit1.rotation.set(0.88, 0.4, 0.15);
  const orbit2 = createEllipse(4.5, 1.7, 0xcfcfcf, 0.2);
  orbit2.rotation.set(1.2, -0.3, 0.7);
  const orbit3 = createEllipse(2.55, 0.95, 0xffffff, 0.28);
  orbit3.rotation.set(0.7, -0.55, 0.35);

  const ringsGroup = new THREE.Group();
  ringsGroup.add(pivot1);
  ringsGroup.add(pivot2);
  ringsGroup.add(pivot3);
  ringsGroup.add(orbit1);
  ringsGroup.add(orbit2);
  ringsGroup.add(orbit3);
  ringsGroup.position.set(0.4, -0.2, 0);
  scene.add(ringsGroup);

  const layerRings = [ringMesh1, ringMesh2, ringMesh3];

  function paintLayer(id) {
    layerRings.forEach((ring) => {
      const selected = String(ring.userData.layerId) === String(id);
      ring.material.opacity = selected ? 0.95 : ring.userData.base * 0.45;
      ring.material.color.set(selected ? 0xffffff : 0x8a8a8a);
    });
  }

  document.querySelectorAll('.layer-tab').forEach((button) => {
    button.addEventListener('click', () => paintLayer(button.dataset.layer));
  });

  function draw() {
    width = container.clientWidth || 480;
    height = container.clientHeight || 480;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    renderer.render(scene, camera);
  }
  renderer.domElement.addEventListener('webglcontextlost', () => { container.hidden = true; });
  window.addEventListener('resize', () => enhanceGraphic(container, draw), { passive: true });
  window.addEventListener('pointermove', (event) => {
    const x = (event.clientX / window.innerWidth) * 2 - 1;
    const y = (event.clientY / window.innerHeight) * 2 - 1;
    ringsGroup.rotation.y = x * 0.28;
    ringsGroup.rotation.x = y * 0.14;
    enhanceGraphic(container, draw);
  }, { passive: true });
  draw();
}

try {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    enhanceGraphic(document.getElementById('bg-canvas'), initMatrixBackground);
    enhanceGraphic(document.getElementById('canvas-3d-container'), init3DStage);
    window.addEventListener('resize', () => {
      enhanceGraphic(document.getElementById('canvas-3d-container'), init3DStage);
    }, { passive: true });
  }
} catch {
  const background = document.getElementById('bg-canvas');
  if (background) background.hidden = true;
  const stage = document.getElementById('canvas-3d-container');
  if (stage) stage.hidden = true;
}
