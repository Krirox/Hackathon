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

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187,
                          0.366025403784439,
                         -0.577350269189626,
                          0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v -   i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
            + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
      m = m * m;
      m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x  = a0.x  * x0.x  + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    float fbm(vec2 p) {
      float f = 0.0;
      f += 0.5000 * snoise(p); p = p * 2.02;
      f += 0.2500 * snoise(p); p = p * 2.03;
      f += 0.1250 * snoise(p);
      return f;
    }

    void main() {
      vec2 coord = gl_FragCoord.xy;
      float spacing = 8.0;
      vec2 cell = floor(coord / spacing);
      vec2 local = fract(coord / spacing) - vec2(0.5);
      float dist = length(local);
      vec2 drift1 = vec2(u_time * 0.035, -u_time * 0.022);
      vec2 drift2 = vec2(-u_time * 0.020, u_time * 0.028);

      float n1 = fbm(cell * 0.016 + drift1);
      float n2 = snoise(cell * 0.032 + drift2);
      float density = mix(n1 * 0.5 + 0.5, n2 * 0.5 + 0.5, 0.35);
      vec2 uv = coord / u_resolution;
      float vigDist = length((uv - vec2(0.5, 0.48)) * vec2(1.0, 1.25));
      vec3 bgDark = vec3(0.031, 0.035, 0.047);
      vec3 bgCenter = vec3(0.075, 0.080, 0.092);
      vec3 bgColor = mix(bgCenter, bgDark, smoothstep(0.15, 0.92, vigDist));
      float dotRadius = 0.25;
      float dotMask = smoothstep(dotRadius, dotRadius - 0.07, dist);
      float cluster = smoothstep(0.30, 0.78, density);
      float dotAlpha = (0.035 + cluster * 0.26) * u_alpha_factor;
      float mouseDist = length(coord - u_mouse);
      if (mouseDist < 190.0) {
        float aura = (1.0 - (mouseDist / 190.0)) * u_alpha_factor;
        dotAlpha += aura * 0.28;
      }
      vec3 dotColor = mix(vec3(0.38, 0.40, 0.45), vec3(0.85, 0.88, 0.92), cluster);

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
    gl.uniform2f(mouseLoc, -1000, -1000);
    gl.uniform1f(alphaLoc, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  canvas.addEventListener('webglcontextlost', () => { canvas.hidden = true; });
  window.addEventListener('resize', () => enhanceGraphic(canvas, draw), { passive: true });
  draw();
}

function init3DStage() {
  const container = document.getElementById('canvas-3d-container');
  if (!container || !container.clientWidth || typeof THREE === 'undefined') return;
  let width = container.clientWidth || 480;
  let height = container.clientHeight || 480;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 1000);
  camera.position.set(0, 0, 12.8);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  container.appendChild(renderer.domElement);
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(6, 10, 8);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x7598c0, 1.6);
  rimLight.position.set(-8, -4, -6);
  scene.add(rimLight);

  const fillLight = new THREE.DirectionalLight(0x3a404c, 0.9);
  fillLight.position.set(0, -6, 4);
  scene.add(fillLight);
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d1f25,
    roughness: 0.35,
    metalness: 0.85,
    side: THREE.DoubleSide
  });

  const activeMaterial = new THREE.MeshStandardMaterial({
    color: 0xeae4db,
    roughness: 0.22,
    metalness: 0.65,
    emissive: 0x3d3830,
    emissiveIntensity: 0.35,
    side: THREE.DoubleSide
  });
  const edgeLineMat = new THREE.LineBasicMaterial({
    color: 0x5a6375,
    transparent: true,
    opacity: 0.35
  });
  function createBandGeometry(outerR, innerR, depth, bevelSize = 0.045) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    shape.holes.push(hole);

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: depth,
      bevelEnabled: true,
      bevelSegments: 5,
      steps: 1,
      bevelSize: bevelSize,
      bevelThickness: bevelSize,
      curveSegments: 96
    });
    geom.center();
    return geom;
  }
  const geom1 = createBandGeometry(4.2, 3.45, 0.62, 0.05);
  const ringMesh1 = new THREE.Mesh(geom1, darkMaterial);
  ringMesh1.userData = { layerId: 3, name: 'Coordination Surface' };
  ringMesh1.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom1, 35), edgeLineMat));
  const geom2 = createBandGeometry(3.25, 2.65, 0.54, 0.045);
  const ringMesh2 = new THREE.Mesh(geom2, darkMaterial);
  ringMesh2.userData = { layerId: 2, name: 'Cognitive Router' };
  ringMesh2.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom2, 35), edgeLineMat));
  const geom3 = createBandGeometry(2.35, 1.85, 0.46, 0.04);
  const ringMesh3 = new THREE.Mesh(geom3, activeMaterial);
  ringMesh3.userData = { layerId: 1, name: 'Reality Ledger' };
  ringMesh3.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom3, 35), edgeLineMat));
  const pivot1 = new THREE.Group();
  pivot1.rotation.set(0.95, 0.2, 0.35);
  pivot1.add(ringMesh1);

  const pivot2 = new THREE.Group();
  pivot2.rotation.set(-0.65, 0.85, -0.25);
  pivot2.add(ringMesh2);

  const pivot3 = new THREE.Group();
  pivot3.rotation.set(0.5, -0.65, 1.15);
  pivot3.add(ringMesh3);
  function createOrbitLine(radius, opacity = 0.28) {
    const points = [];
    const segments = 120;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: 0x99aabf,
      transparent: true,
      opacity: opacity
    });
    return new THREE.LineLoop(geom, mat);
  }

  const orbit1 = createOrbitLine(4.55, 0.26);
  orbit1.rotation.set(0.35, 0.45, 0.2);

  const orbit2 = createOrbitLine(3.55, 0.22);
  orbit2.rotation.set(-0.55, 0.35, 0.85);

  const orbit3 = createOrbitLine(2.55, 0.32);
  orbit3.rotation.set(0.65, -0.45, 0.55);
  const ringsGroup = new THREE.Group();
  ringsGroup.add(pivot1);
  ringsGroup.add(pivot2);
  ringsGroup.add(pivot3);
  ringsGroup.add(orbit1);
  ringsGroup.add(orbit2);
  ringsGroup.add(orbit3);
  scene.add(ringsGroup);
  ringsGroup.position.set(0, 0, 0);


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
  draw();
}

try {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    enhanceGraphic(document.getElementById('bg-canvas'), initMatrixBackground);
    enhanceGraphic(document.getElementById('canvas-3d-container'), init3DStage);
  }
} catch {
  const background = document.getElementById('bg-canvas');
  if (background) background.hidden = true;
  const stage = document.getElementById('canvas-3d-container');
  if (stage) stage.hidden = true;
}
