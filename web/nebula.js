/* WebGL 星云背景：GPU shader 流动极光，鼠标可拨动。
   性能策略：自适应分辨率 + 3 层噪声 + 空闲降帧 + 迟滞降采样；无 CSS 模糊。 */
(function () {
  'use strict';
  if (document.documentElement.dataset.nebula === '1') return;
  document.documentElement.dataset.nebula = '1';

  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (reduce && reduce.matches) return;

  var canvas = document.createElement('canvas');
  canvas.className = 'fx-nebula';
  canvas.setAttribute('aria-hidden', 'true');

  var gl = canvas.getContext('webgl', {
    antialias: false, alpha: true, depth: false, stencil: false,
    premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: 'low-power', desynchronized: true
  }) || canvas.getContext('experimental-webgl', { antialias: false, alpha: true, depth: false });
  if (!gl) return;

  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FS = [
    'precision highp float;',
    'uniform vec2 u_res; uniform float u_time; uniform vec2 u_mouse;',
    'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);',
    ' return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}',
    'float fbm(vec2 p){float v=0.,a=.55;for(int i=0;i<3;i++){v+=a*noise(p);p*=2.07;a*=.55;}return v;}',
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/u_res.xy;',
    ' float ar=u_res.x/u_res.y;',
    ' vec2 p=(uv-.5)*vec2(ar,1.);',
    ' vec2 m=(u_mouse-.5)*vec2(ar,1.);',
    ' float t=u_time*.045;',
    ' p+=m*.07;',
    ' float n=fbm(p*1.7+vec2(t*.6,-t*.4));',
    ' float n2=fbm(p*2.6+vec2(-t*.5,t*.65)+n*.5);',
    ' float band=smoothstep(.34,.86,n*.45+n2*.55);',
    ' vec3 c1=vec3(.16,.28,.85);',
    ' vec3 c2=vec3(.10,.72,.84);',
    ' vec3 c3=vec3(.46,.36,.88);',
    ' vec3 col=mix(c1,c2,smoothstep(.2,.8,n));',
    ' col=mix(col,c3,smoothstep(.35,.92,n2));',
    ' gl_FragColor=vec4(col*band*(.30+.40*n),1.);',
    '}'
  ].join('\n');

  function sh(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  var prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'u_res');
  var uTime = gl.getUniformLocation(prog, 'u_time');
  var uMouse = gl.getUniformLocation(prog, 'u_mouse');

  var W = 1, H = 1, mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5;
  var SCALE = 0.42;
  var ema = 16, lastDraw = 0, lastMove = 0, lastScale = 0, t0 = performance.now(), raf = 0;

  function resize() {
    var h = Math.max(2, Math.floor(window.innerHeight * SCALE));
    var w = Math.max(2, Math.floor(window.innerWidth * SCALE));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    gl.viewport(0, 0, W, H);
    gl.uniform2f(uRes, W, H);
  }

  window.addEventListener('mousemove', function (e) {
    tmx = e.clientX / window.innerWidth;
    tmy = 1 - e.clientY / window.innerHeight;
    lastMove = performance.now();
  }, { passive: true });
  window.addEventListener('resize', resize);

  document.body.insertBefore(canvas, document.body.firstChild);
  resize();

  function frame(now) {
    raf = window.requestAnimationFrame(frame);
    if (document.hidden) return;

    var idleFor = now - lastMove;
    var interval = idleFor > 1800 ? 50 : 33; // 空闲 20fps，交互 30fps
    if (now - lastDraw < interval - 1) return;
    if (lastDraw) ema = ema * 0.9 + (now - lastDraw) * 0.1;
    lastDraw = now;

    // 迟滞降采样：持续掉帧降一档；长期宽裕再慢慢升回去
    if (ema > 52 && SCALE > 0.28 && now - lastScale > 2500) {
      SCALE = Math.max(0.28, SCALE * 0.85);
      resize();
      ema = 33;
      lastScale = now;
    } else if (ema < 22 && SCALE < 0.42 && now - lastScale > 12000) {
      SCALE = Math.min(0.42, SCALE * 1.12);
      resize();
      lastScale = now;
    }

    mx += (tmx - mx) * 0.06;
    my += (tmy - my) * 0.06;
    gl.uniform1f(uTime, (now - t0) / 1000);
    gl.uniform2f(uMouse, mx, my);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf = window.requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { t0 = performance.now() - 1000; lastDraw = 0; }
  });
  window.addEventListener('beforeunload', function () { window.cancelAnimationFrame(raf); });
})();
