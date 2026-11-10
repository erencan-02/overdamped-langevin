import { describe, expect, it } from 'vitest';
import { gpuName } from '../src/render/gpuInfo';

describe('gpuName', () => {
  it('extracts the model from ANGLE renderer strings', () => {
    expect(gpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(
      'NVIDIA GeForce RTX 3060 Laptop GPU',
    );
    expect(gpuName('ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(
      'Intel(R) UHD Graphics 620',
    );
    expect(gpuName('Apple M2')).toBe('Apple M2');
  });
});
