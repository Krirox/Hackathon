/**
 * VITAL — The Autonomous Enterprise
 * Animated Cybernetic Dot-Matrix Background (WebGL FBM Shader) +
 * 3D Gyroscopic Rings Engine (Three.js) + Console Wiring
 */

// =============================================================================
// 1. Initial Loader Screen
// =============================================================================
const loader = document.getElementById('loader');
if (loader) {
  window.addEventListener('load', () => {
    setTimeout(() => loader.classList.add('done'), 1000);
  });
  setTimeout(() => loader.classList.add('done'), 2200);
}

// =============================================================================
// 2. Animated Cybernetic Dot-Matrix Background (WebGL Shader)
// Exactly matching the reference image's organic stippled drifting matrix
// =============================================================================
(function initMatrixBackground() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'high-performance' }) ||
             canvas.getContext('experimental-webgl');

  if (!gl) {
    initMatrixCanvas2D(canvas);
    return;
  }

  // Vertex Shader
  const vsSource = `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Fragment Shader: 2D Simplex Noise + FBM for organic drifting clusters of micro-dots
  const fsSource = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_mouse;

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
      
      // Fine micro-dot spacing matching the reference image (~7.5 to 8 pixels)
      float spacing = 8.0;
      vec2 cell = floor(coord / spacing);
      vec2 local = fract(coord / spacing) - vec2(0.5);
      float dist = length(local);

      // Continuous organic drifting animation
      vec2 drift1 = vec2(u_time * 0.035, -u_time * 0.022);
      vec2 drift2 = vec2(-u_time * 0.020, u_time * 0.028);

      float n1 = fbm(cell * 0.016 + drift1);
      float n2 = snoise(cell * 0.032 + drift2);
      float density = mix(n1 * 0.5 + 0.5, n2 * 0.5 + 0.5, 0.35);

      // Radial dark atmosphere matching reference screenshot
      vec2 uv = coord / u_resolution;
      float vigDist = length((uv - vec2(0.5, 0.48)) * vec2(1.0, 1.25));
      vec3 bgDark = vec3(0.048, 0.050, 0.056);
      vec3 bgCenter = vec3(0.082, 0.086, 0.096);
      vec3 bgColor = mix(bgCenter, bgDark, smoothstep(0.15, 0.92, vigDist));

      // Crisp micro-dot shape (approx 1.8px diameter)
      float dotRadius = 0.25;
      float dotMask = smoothstep(dotRadius, dotRadius - 0.07, dist);

      // Density clusters: high density = glowing stipple clouds; low density = subtle dots
      float cluster = smoothstep(0.30, 0.78, density);
      float dotAlpha = 0.035 + cluster * 0.26;

      // Mouse interactive aura
      float mouseDist = length(coord - u_mouse);
      if (mouseDist < 190.0) {
        float aura = 1.0 - (mouseDist / 190.0);
        dotAlpha += aura * 0.28;
      }

      // Silver / platinum dot color with subtle lime undertone on bright spots
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
    initMatrixCanvas2D(canvas);
    return;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(program));
    initMatrixCanvas2D(canvas);
    return;
  }

  // Fullscreen Quad Buffer
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

  let mouseX = -1000;
  let mouseY = -1000;
  let targetMouseX = -1000;
  let targetMouseY = -1000;
  let dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  window.addEventListener('resize', resize, { passive: true });
  resize();

  window.addEventListener('mousemove', (e) => {
    targetMouseX = e.clientX * dpr;
    targetMouseY = (window.innerHeight - e.clientY) * dpr; // invert Y for WebGL
  }, { passive: true });

  window.addEventListener('mouseleave', () => {
    targetMouseX = -1000;
    targetMouseY = -1000;
  });

  let startTime = performance.now();

  function renderFrame(now) {
    const elapsed = (now - startTime) * 0.001;

    // Smooth mouse lerp
    mouseX += (targetMouseX - mouseX) * 0.08;
    mouseY += (targetMouseY - mouseY) * 0.08;

    gl.useProgram(program);

    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(resLoc, canvas.width, canvas.height);
    gl.uniform1f(timeLoc, elapsed);
    gl.uniform2f(mouseLoc, mouseX, mouseY);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
})();

// Canvas 2D Fallback
function initMatrixCanvas2D(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  function draw() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    ctx.fillStyle = '#0e0f13';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', draw);
  draw();
}

// =============================================================================
// 3. Three.js 3D Gyroscopic Rings Engine (Matching Reference Images 2 & 3)
// =============================================================================
(function init3DStage() {
  const container = document.getElementById('canvas-3d-container');
  if (!container || typeof THREE === 'undefined') return;

  const width = container.clientWidth || 860;
  const height = container.clientHeight || 560;

  // Scene & Perspective Camera
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 1000);
  camera.position.set(0, 0, 12.8);

  // WebGL Renderer
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

  // Lighting Setup catching beveled rims
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

  // ---------------------------------------------------------------------------
  // Materials: Dark Obsidian Gunmetal & Champagne Bone Metallic
  // ---------------------------------------------------------------------------
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

  // Edge line material for that razor-sharp CAD silhouette (Image 2 style)
  const edgeLineMat = new THREE.LineBasicMaterial({
    color: 0x5a6375,
    transparent: true,
    opacity: 0.35
  });

  // ---------------------------------------------------------------------------
  // Geometry Generator: Thick Rounded Ribbon Rings with Bevels
  // ---------------------------------------------------------------------------
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

  // Ring 1 (Front/Outer Band - Layer 3: TALK / Coordination Spine)
  // Large dramatic sweeping arch matching Reference Image 2
  const geom1 = createBandGeometry(4.2, 3.45, 0.62, 0.05);
  const ringMesh1 = new THREE.Mesh(geom1, darkMaterial.clone());
  ringMesh1.userData = { layerId: 3, name: 'Coordination Spine' };

  const edges1 = new THREE.LineSegments(new THREE.EdgesGeometry(geom1, 35), edgeLineMat);
  ringMesh1.add(edges1);

  // Ring 2 (Middle Band - Layer 2: COMPUTE / Router & Compiler)
  const geom2 = createBandGeometry(3.25, 2.65, 0.54, 0.045);
  const ringMesh2 = new THREE.Mesh(geom2, darkMaterial.clone());
  ringMesh2.userData = { layerId: 2, name: 'Cognitive Router' };

  const edges2 = new THREE.LineSegments(new THREE.EdgesGeometry(geom2, 35), edgeLineMat);
  ringMesh2.add(edges2);

  // Ring 3 (Inner Band - Layer 1: CLAIM / Reality Ledger)
  const geom3 = createBandGeometry(2.35, 1.85, 0.46, 0.04);
  // Default layer 1 active initially (matching Image 3)
  const ringMesh3 = new THREE.Mesh(geom3, activeMaterial.clone());
  ringMesh3.userData = { layerId: 1, name: 'Reality Ledger' };

  const edges3 = new THREE.LineSegments(new THREE.EdgesGeometry(geom3, 35), edgeLineMat);
  ringMesh3.add(edges3);

  // Pivot groups for organic gyroscopic precession
  const pivot1 = new THREE.Group();
  pivot1.rotation.set(0.95, 0.2, 0.35);
  pivot1.add(ringMesh1);

  const pivot2 = new THREE.Group();
  pivot2.rotation.set(-0.65, 0.85, -0.25);
  pivot2.add(ringMesh2);

  const pivot3 = new THREE.Group();
  pivot3.rotation.set(0.5, -0.65, 1.15);
  pivot3.add(ringMesh3);

  // ---------------------------------------------------------------------------
  // Delicate Wireframe Orbit Lines & Orbiting Satellites (Image 2 style)
  // ---------------------------------------------------------------------------
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

  // Tiny orbiting glowing sparks
  const sparkGeom = new THREE.SphereGeometry(0.045, 16, 16);
  const sparkMatLime = new THREE.MeshBasicMaterial({ color: 0xd9ffa8 });
  const sparkMatWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const spark1 = new THREE.Mesh(sparkGeom, sparkMatLime);
  const spark2 = new THREE.Mesh(sparkGeom, sparkMatWhite);
  const spark3 = new THREE.Mesh(sparkGeom, sparkMatLime);

  scene.add(spark1);
  scene.add(spark2);
  scene.add(spark3);

  // Main Assembly Group
  const ringsGroup = new THREE.Group();
  ringsGroup.add(pivot1);
  ringsGroup.add(pivot2);
  ringsGroup.add(pivot3);
  ringsGroup.add(orbit1);
  ringsGroup.add(orbit2);
  ringsGroup.add(orbit3);
  scene.add(ringsGroup);

  // Position: centered and grand in the hero space
  ringsGroup.position.set(0, -0.3, 0);

  // ---------------------------------------------------------------------------
  // Layer State & Interactive Tooltip
  // ---------------------------------------------------------------------------
  const layerMeshes = [ringMesh3, ringMesh2, ringMesh1];
  let currentActiveLayer = 1;

  const cardTag = document.getElementById('card-tag');
  const cardDesc = document.getElementById('card-description');
  const floatingCard = document.getElementById('floating-layer-card');

  const layerData = {
    1: {
      tag: 'Reality Ledger',
      desc: 'Append-only ground truth. No model may mint a FACT.',
      badge: 'LAYER 01 · REALITY LEDGER',
      title: 'Append-Only Ground Truth',
      longDesc: 'Every claim has cryptographic provenance. Decisions freeze full Context Bundles so outcomes are audited with zero archaeological digging.'
    },
    2: {
      tag: 'Cognitive Router',
      desc: 'REFLEX → WORKFLOW → MODEL → HUMAN with escalation caps.',
      badge: 'LAYER 02 · ROUTER & COMPILER',
      title: 'Attention & Procedure Compiler',
      longDesc: 'Deterministic reflexes handle 99% of traffic. Procedures graduate quarantine → shadow → pilot → promoted under transfer testing.'
    },
    3: {
      tag: 'Coordination Spine',
      desc: 'Typed QUERY / REQUEST / NOTICE over signed talk bindings.',
      badge: 'LAYER 03 · COORDINATION SPINE',
      title: 'Buzz & Nostr Talk Surface',
      longDesc: 'Chat is an ephemeral projection — never the store. Attention is budgeted, refusable, and replayed with signed cryptographic bindings.'
    }
  };

  function setActiveLayer(layerId) {
    currentActiveLayer = layerId;

    layerMeshes.forEach((mesh) => {
      if (mesh.userData.layerId === layerId) {
        mesh.material = activeMaterial;
      } else {
        mesh.material = darkMaterial;
      }
    });

    const data = layerData[layerId];
    if (data) {
      if (cardTag) cardTag.textContent = data.tag;
      if (cardDesc) cardDesc.textContent = data.desc;

      const detailBadge = document.getElementById('detail-badge');
      const detailTitle = document.getElementById('detail-title');
      const detailDesc = document.getElementById('detail-desc');
      if (detailBadge) detailBadge.textContent = data.badge;
      if (detailTitle) detailTitle.textContent = data.title;
      if (detailDesc) detailDesc.textContent = data.longDesc;
    }

    document.querySelectorAll('.layer-tab').forEach((tab) => {
      const tabLayer = parseInt(tab.dataset.layer, 10);
      if (tabLayer === layerId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });
  }

  document.querySelectorAll('.layer-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const layerId = parseInt(tab.dataset.layer, 10);
      setActiveLayer(layerId);
    });
  });

  if (floatingCard) {
    floatingCard.addEventListener('click', () => {
      const nextLayer = (currentActiveLayer % 3) + 1;
      setActiveLayer(nextLayer);
    });
  }

  // ---------------------------------------------------------------------------
  // Raycasting & Mouse Parallax
  // ---------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const mouseRay = new THREE.Vector2(-10, -10);

  function onPointerMove(e) {
    const rect = container.getBoundingClientRect();
    mouseRay.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRay.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function onPointerClick(e) {
    onPointerMove(e);
    raycaster.setFromCamera(mouseRay, camera);
    const intersects = raycaster.intersectObjects([ringMesh1, ringMesh2, ringMesh3]);
    if (intersects.length > 0) {
      const clickedMesh = intersects[0].object;
      if (clickedMesh.userData && clickedMesh.userData.layerId) {
        setActiveLayer(clickedMesh.userData.layerId);
      }
    }
  }

  container.addEventListener('mousemove', onPointerMove, { passive: true });
  container.addEventListener('click', onPointerClick);

  let targetRotationX = 0;
  let targetRotationY = 0;
  let currentRotationX = 0;
  let currentRotationY = 0;

  window.addEventListener('mousemove', (e) => {
    const normX = (e.clientX / window.innerWidth) * 2 - 1;
    const normY = (e.clientY / window.innerHeight) * 2 - 1;
    targetRotationY = normX * 0.35;
    targetRotationX = normY * 0.25;
  }, { passive: true });

  function handleResize() {
    const newW = container.clientWidth || 860;
    const newH = container.clientHeight || 560;
    camera.aspect = newW / newH;
    camera.updateProjectionMatrix();
    renderer.setSize(newW, newH);
  }
  window.addEventListener('resize', handleResize, { passive: true });

  // ---------------------------------------------------------------------------
  // Animation Loop with continuous gyroscopic motion
  // ---------------------------------------------------------------------------
  let clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    // Harmonic gyroscopic rotation of rings
    pivot1.rotation.z += delta * 0.24;
    pivot1.rotation.x += delta * 0.08;

    pivot2.rotation.y += delta * 0.28;
    pivot2.rotation.z -= delta * 0.12;

    pivot3.rotation.x += delta * 0.34;
    pivot3.rotation.y += delta * 0.16;

    // Orbit wireframes
    orbit1.rotation.z += delta * 0.05;
    orbit2.rotation.x -= delta * 0.07;
    orbit3.rotation.y += delta * 0.09;

    // Orbiting sparks
    const t1 = elapsed * 0.8;
    spark1.position.set(Math.cos(t1) * 4.55, Math.sin(t1) * 4.55, Math.sin(t1 * 2) * 0.4);

    const t2 = -elapsed * 1.1 + 1.5;
    spark2.position.set(Math.cos(t2) * 3.55, Math.sin(t2) * 3.55, Math.cos(t2 * 2) * 0.3);

    const t3 = elapsed * 1.4 + 3.0;
    spark3.position.set(Math.cos(t3) * 2.55, Math.sin(t3) * 2.55, Math.sin(t3 * 3) * 0.2);

    // Parallax damping
    currentRotationX += (targetRotationX - currentRotationX) * 0.05;
    currentRotationY += (targetRotationY - currentRotationY) * 0.05;

    const scrollY = window.scrollY || 0;
    ringsGroup.position.y = -0.3 - scrollY * 0.0008;

    ringsGroup.rotation.x = currentRotationX + Math.sin(elapsed * 0.4) * 0.035;
    ringsGroup.rotation.y = currentRotationY + Math.cos(elapsed * 0.3) * 0.035;

    raycaster.setFromCamera(mouseRay, camera);
    const hits = raycaster.intersectObjects([ringMesh1, ringMesh2, ringMesh3]);
    container.style.cursor = hits.length > 0 ? 'pointer' : 'grab';

    renderer.render(scene, camera);
  }

  animate();
})();

// =============================================================================
// 4. Console Wiring (Preserved 100% — SECURITY.md / Auth Endpoints)
// =============================================================================
(function initConsoleWiring() {
  const consoleBase = (document.querySelector('meta[name="vital-console-url"]')?.content || '').replace(/\/$/, '');
  const consolePath = (p) => (consoleBase ? p.replace(/^\//, consoleBase + '/') : p);

  document.querySelectorAll('[data-console]').forEach((a) => {
    a.href = consolePath(a.dataset.consolePath || '/');
    a.target = '_blank';
    a.rel = 'noopener';
  });

  const status = document.getElementById('console-status');
  if (status && consoleBase) {
    const paint = (cls, text) => {
      status.textContent = '● ' + text;
      status.className = cls;
    };
    paint('unknown', 'console status unknown');
    fetch(consoleBase + '/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(
        (j) => paint('live', `console live · ${j.engine} · ${new Date(j.at).toLocaleTimeString()}`),
        () => paint('down', 'console not reachable')
      );
  }
})();

// =============================================================================
// 5. Scroll Reveals & Navigation Interactions
// =============================================================================
(function initInteractions() {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  document.querySelectorAll('.reveal, .reveal-scale, .media').forEach((el) => io.observe(el));

  const bar = document.getElementById('progress-bar');
  window.addEventListener('scroll', () => {
    const h = document.documentElement;
    const p = h.scrollTop / (h.scrollHeight - h.clientHeight);
    if (bar) bar.style.width = p * 100 + '%';
  }, { passive: true });

  const ov = document.getElementById('overlay');
  const menuBtn = document.getElementById('menu-btn');
  const closeBtn = document.getElementById('overlay-close');

  if (menuBtn && ov) {
    menuBtn.onclick = () => {
      ov.classList.add('open');
      ov.setAttribute('aria-hidden', 'false');
    };
  }

  if (closeBtn && ov) {
    closeBtn.onclick = () => {
      ov.classList.remove('open');
      ov.setAttribute('aria-hidden', 'true');
    };
  }

  if (ov) {
    ov.querySelectorAll('a').forEach((a) => {
      a.onclick = () => {
        ov.classList.remove('open');
        ov.setAttribute('aria-hidden', 'true');
      };
    });
  }

  document.querySelectorAll('.cta-contact, .cta-btn').forEach((b) => {
    b.addEventListener('mousemove', (e) => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.08}px, ${(e.clientY - r.top - r.height / 2) * 0.12}px)`;
    });
    b.addEventListener('mouseleave', () => {
      b.style.transform = '';
    });
  });
})();
