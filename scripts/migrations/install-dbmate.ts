import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { dbmatePath, dbmateVersion } from "./dbmate.ts";
const assets: Record<string, [string, string]> = {
  "darwin-arm64": [
    "dbmate-macos-arm64",
    "902d80f060cf9ffa89c15e14517413afd398fa787740cf67862d10b8821734d5",
  ],
  "darwin-x64": [
    "dbmate-macos-amd64",
    "a906a27037393738ef56793749d915c4b64e9243c0a2b54d388825c1f9ddd2f7",
  ],
  "linux-x64": [
    "dbmate-linux-amd64",
    "f855e99a0f0a81322014bf686b1cb820d2b4d8074e4eadafd64b851b80ecb15a",
  ],
  "linux-arm64": [
    "dbmate-linux-arm64",
    "42de2bf27989192b9ca8db4cfaa0a9d6b4aee154a03abef30239b7186b1baf82",
  ],
};
const asset = assets[`${process.platform}-${process.arch}`];
if (!asset) throw Error("This demo installer supports macOS/Linux arm64/x64");
const response = await fetch(
  `https://github.com/amacneil/dbmate/releases/download/v${dbmateVersion}/${asset[0]}`,
);
if (!response.ok) throw Error(`dbmate download failed (${response.status})`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== asset[1])
  throw Error("dbmate checksum mismatch");
await mkdir(dirname(dbmatePath), { recursive: true });
const temporary = dbmatePath + ".download";
try {
  await writeFile(temporary, bytes);
  await chmod(temporary, 0o755);
  await rename(temporary, dbmatePath);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Verified dbmate ${dbmateVersion} installed in work/tools (not globally).`);
