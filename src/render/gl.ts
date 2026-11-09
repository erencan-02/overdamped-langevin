/** Minimal WebGL2 helpers. */

export interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation>;
  attribs: Record<string, number>;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error:\n${log}\n${source}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create program');
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Program link error:\n${gl.getProgramInfoLog(program)}`);
  }
  const uniforms: Record<string, WebGLUniformLocation> = {};
  const nu = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(program, info.name);
    if (loc) uniforms[name] = loc;
  }
  const attribs: Record<string, number> = {};
  const na = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (info) attribs[info.name] = gl.getAttribLocation(program, info.name);
  }
  return { program, uniforms, attribs };
}

export function createBuffer(
  gl: WebGL2RenderingContext,
  data: BufferSource | number,
  usage: number = gl.STATIC_DRAW,
): WebGLBuffer {
  const buf = gl.createBuffer();
  if (!buf) throw new Error('Could not create buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  if (typeof data === 'number') gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  else gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  return buf;
}
