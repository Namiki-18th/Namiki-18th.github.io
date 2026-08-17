import crypto from "crypto";
import fs from "fs";

const key = crypto.randomBytes(32); // AES-256
fs.writeFileSync(".env", `STUDENT_KEY=${key.toString("hex")}`);

const iv = crypto.randomBytes(12); // GCMは12バイト推奨
const data = fs.readFileSync("students.json");

const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
const tag = cipher.getAuthTag();

fs.writeFileSync("students.enc", encrypted);
fs.writeFileSync("students.iv", iv);
fs.writeFileSync("students.tag", tag);

console.log("暗号化完了。GitHubに置いてOKなのは .enc / .iv / .tag だけ。");
