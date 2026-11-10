/** What the browser tells about the GPU it would draw with. */
export interface GpuInfo {
  /** WebGL2 works (in hardware or in software). */
  available: boolean;
  /** A hardware GPU does the drawing (false: WebGL is emulated on the CPU, or unavailable). */
  hardware: boolean;
  /** Model name as reported by the browser (it may be generic for privacy), or null. */
  name: string | null;
}

/** Renderer names of WebGL implementations that run on the CPU. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software|\bwarp\b|mesa offscreen/i;

/**
 * Describes the GPU behind `gl` (the app's WebGL2 context, or null if there is none). Browsers
 * report the model through WEBGL_debug_renderer_info; some report only a generic name. Whether
 * it is real hardware is told by the name and by asking for a context that refuses software
 * rendering (`failIfMajorPerformanceCaveat`).
 */
export function detectGpu(gl: WebGL2RenderingContext | null): GpuInfo {
  if (!gl) return { available: false, hardware: false, name: null };
  let raw = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    raw = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    raw = '';
  }
  const name = raw ? gpuName(raw) : null;
  const hardware = !SOFTWARE.test(raw) && hardwareContextAvailable();
  return { available: true, hardware, name };
}

/** Whether the browser grants a WebGL2 context without a major performance caveat (i.e. not in software). */
function hardwareContextAvailable(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // give the test context back at once
    return gl !== null;
  } catch {
    return false;
  }
}

/**
 * A readable model name from a WebGL renderer string, e.g.
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)"
 * → "NVIDIA GeForce RTX 3060 Laptop GPU". Unknown formats are returned as they are.
 */
export function gpuName(raw: string): string {
  const s = raw.trim();
  const angle = /^ANGLE \((.*)\)$/s.exec(s);
  if (!angle) return s;
  // "vendor, device …, backend": the device is the second part.
  const parts = angle[1].split(',').map((p) => p.trim());
  let device = parts.length >= 2 ? parts[1] : parts[0];
  device = device
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '') // PCI id
    .replace(/\s+(Direct3D\d*|D3D\d+|OpenGL( ES)?( Engine)?|Vulkan|Metal)\b.*$/i, '') // backend details
    .trim();
  return device || s;
}
