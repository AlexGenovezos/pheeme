// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_UNPACKED_BYTES,
  checkBundle,
  checkPng,
  crc32,
} from "./bundle";
import { APP_BUNDLE_BASE64, fromBase64, goodPng, ihdr, pngOf, zipOf } from "./testdata";

const text = (s: string) => new TextEncoder().encode(s);
const summary = { name: "summary.json", data: text("{}") };

describe("checkBundle", () => {
  it("accepts a bundle the app wrote, screenshots and all", () => {
    expect(checkBundle(fromBase64(APP_BUNDLE_BASE64))).toBeNull();
  });

  it("accepts every file the app writes", () => {
    const zip = zipOf([
      summary,
      { name: "logs/pheeme.log", data: text("log") },
      { name: "email/thread.json", data: text("[]") },
      { name: "email/18c2f_a9/original.html", data: text("<p>") },
      { name: "email/18c2f_a9/shown.html", data: text("<p>") },
      { name: "email/18c2f_a9/body.txt", data: text("hi") },
      { name: "screenshots/1.png", data: goodPng() },
      { name: "screenshots/2.png", data: goodPng(2560, 1600) },
      { name: "screenshots/3.png", data: goodPng(1, 1) },
    ]);
    expect(checkBundle(zip)).toBeNull();
  });

  it.each([
    "screenshots/1.exe",
    "screenshots/4.png",
    "screenshots/1.png.exe",
    "invoice.pdf",
    "logs/../../evil.sh",
    "/etc/passwd",
    "email/a/b/body.txt",
    "email/x/run.sh",
  ])("refuses a bundle holding %s", (name) => {
    expect(checkBundle(zipOf([summary, { name, data: goodPng() }]))).toBe(
      "Bundle has an unexpected file",
    );
  });

  it("refuses a program renamed to a screenshot", () => {
    const exe = text("MZ\u0090\u0000 this program cannot be run in DOS mode");
    expect(checkBundle(zipOf([{ name: "screenshots/1.png", data: exe }]))).toBe(
      "screenshots/1.png: not a PNG",
    );
  });

  it("refuses a screenshot with something after the image", () => {
    const png = goodPng();
    const tampered = new Uint8Array(png.length + 9);
    tampered.set(png);
    tampered.set(text("PK\u0003\u0004#!/bi"), png.length);
    expect(checkBundle(zipOf([{ name: "screenshots/1.png", data: tampered }]))).toBe(
      "screenshots/1.png: has data after the image",
    );
  });

  it("refuses a compressed screenshot, which it couldn't check", () => {
    expect(checkBundle(zipOf([{ name: "screenshots/1.png", data: goodPng(), method: 8 }]))).toBe(
      "Screenshot is compressed",
    );
  });

  it("refuses a screenshot whose bytes don't match the zip's checksum", () => {
    const data = goodPng();
    expect(checkBundle(zipOf([{ name: "screenshots/1.png", data, crc: crc32(data) ^ 1 }]))).toBe(
      "Screenshot is damaged",
    );
  });

  it("refuses a repeated name, an encrypted entry and trailing bytes", () => {
    expect(checkBundle(zipOf([summary, summary]))).toBe("Bundle repeats a file");

    const encrypted = zipOf([summary]);
    const dirStart = new DataView(encrypted.buffer).getUint32(encrypted.length - 6, true);
    encrypted[dirStart + 8] = 1;
    expect(checkBundle(encrypted)).toBe("Bundle is encrypted");

    const zip = zipOf([summary]);
    const padded = new Uint8Array(zip.length + 4);
    padded.set(zip);
    expect(checkBundle(padded)).toBe("Bundle is not a readable zip");
  });

  it("refuses a directory with more entries than its count says", () => {
    const zip = zipOf([summary, { name: "screenshots/1.png", data: text("MZ") }]);
    const view = new DataView(zip.buffer);
    view.setUint16(zip.length - 14, 1, true); // entries on this disk
    view.setUint16(zip.length - 12, 1, true); // entries in total
    expect(checkBundle(zip)).toBe("Bundle is not a readable zip");
  });

  it("accepts a long thread's many files", () => {
    const entries = [summary];
    for (let m = 0; m < 100; m++) {
      for (const file of ["original.html", "shown.html", "body.txt"]) {
        entries.push({ name: `email/m${m}/${file}`, data: text("x") });
      }
    }
    expect(checkBundle(zipOf(entries))).toBeNull();
  });

  it("refuses a small zip that would unpack to too much", () => {
    const deflated = (name: string, size: number) => ({ name, data: text("x"), method: 8, size });
    const oneHuge = zipOf([summary, deflated("logs/pheeme.log", MAX_FILE_BYTES + 1)]);
    expect(checkBundle(oneHuge)).toBe("Bundle is too large unpacked");
    const each = Math.floor(MAX_FILE_BYTES / 2);
    const count = Math.ceil(MAX_UNPACKED_BYTES / each) + 1;
    const many = [summary];
    for (let m = 0; m < count; m++) many.push(deflated(`email/m${m}/body.txt`, each));
    expect(checkBundle(zipOf(many))).toBe("Bundle is too large unpacked");
    expect(checkBundle(zipOf([summary, deflated("logs/pheeme.log", MAX_FILE_BYTES)]))).toBeNull();
  });

  it("refuses a zip whose directory points past the end", () => {
    const zip = zipOf([{ name: "screenshots/1.png", data: goodPng() }]);
    const view = new DataView(zip.buffer);
    const dirStart = view.getUint32(zip.length - 6, true);
    view.setUint32(dirStart + 42, zip.length, true);
    expect(checkBundle(zip)).toBe("Bundle is not a readable zip");
  });
});

describe("checkPng", () => {
  const idat = (): [string, Uint8Array] => ["IDAT", Uint8Array.of(1)];
  const iend = (): [string, Uint8Array] => ["IEND", new Uint8Array()];

  it("accepts RGB and RGBA at 8 bits", () => {
    expect(checkPng(goodPng())).toBeNull();
    expect(checkPng(pngOf([["IHDR", ihdr(4, 4, 8, 6)], idat(), iend()]))).toBeNull();
  });

  it.each([
    [
      "a text chunk",
      [["IHDR", ihdr(4, 4)], ["tEXt", text("Comment\0hi")], idat(), iend()],
      'unexpected "tEXt" chunk',
    ],
    [
      "an ICC profile",
      [["IHDR", ihdr(4, 4)], ["iCCP", text("x")], idat(), iend()],
      'unexpected "iCCP" chunk',
    ],
    ["no header first", [idat(), ["IHDR", ihdr(4, 4)], iend()], 'unexpected "IDAT" chunk'],
    ["no image data", [["IHDR", ihdr(4, 4)], iend()], 'unexpected "IEND" chunk'],
    [
      "two headers",
      [["IHDR", ihdr(4, 4)], ["IHDR", ihdr(4, 4)], idat(), iend()],
      'unexpected "IHDR" chunk',
    ],
    ["no end", [["IHDR", ihdr(4, 4)], idat()], "cut short"],
    ["a canvas too wide", [["IHDR", ihdr(2561, 10)], idat(), iend()], "wrong size"],
    ["an empty canvas", [["IHDR", ihdr(0, 10)], idat(), iend()], "wrong size"],
    ["16-bit pixels", [["IHDR", ihdr(4, 4, 16)], idat(), iend()], "unexpected pixel format"],
    ["a palette", [["IHDR", ihdr(4, 4, 8, 3)], idat(), iend()], "unexpected pixel format"],
  ] as [string, [string, Uint8Array][], string][])("refuses %s", (_name, chunks, why) => {
    expect(checkPng(pngOf(chunks))).toBe(why);
  });

  it("refuses a chunk with a bad checksum", () => {
    const png = goodPng();
    png[png.length - 20] ^= 0xff; // inside IDAT
    expect(checkPng(png)).toBe("damaged");
  });

  it("refuses one over the size limit", () => {
    expect(checkPng(new Uint8Array(MAX_SCREENSHOT_BYTES + 1))).toBe("too large");
  });

  it("refuses an SVG or HTML named .png", () => {
    expect(checkPng(text("<svg onload=alert(1)>"))).toBe("not a PNG");
  });
});
