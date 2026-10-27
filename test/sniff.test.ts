import { describe, expect, it } from "vitest";
import { sniffRasterImageType } from "../src/sniff";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const AVIF = Uint8Array.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
]);

describe("sniffRasterImageType", () => {
  it("recognises the formats Gravatar serves", () => {
    expect(sniffRasterImageType(PNG)).toBe("image/png");
    expect(sniffRasterImageType(JPEG)).toBe("image/jpeg");
    expect(sniffRasterImageType(GIF)).toBe("image/gif");
    expect(sniffRasterImageType(WEBP)).toBe("image/webp");
    expect(sniffRasterImageType(AVIF)).toBe("image/avif");
  });

  it("rejects anything that is not a raster image", () => {
    expect(sniffRasterImageType(new Uint8Array(0))).toBeNull();
    expect(sniffRasterImageType(new TextEncoder().encode("<!doctype html>"))).toBeNull();
    expect(sniffRasterImageType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(sniffRasterImageType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});
