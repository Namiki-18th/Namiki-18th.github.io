//＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝
//もし君がハッカーに憧れてstudent.jsonを解析しようとしているならやめておきな。
//君が115792089237316195423570985008687907853269984665640564039457584007913129639936回の総当たりをできるなら話は別だけど。
//
//If you're looking at this script and thinking about parsing student.json, 
//don't bother—unless you're prepared to run a brute-force attack involving
// 115792089237316195423570985008687907853269984665640564039457584007913129639936 iterations.
//＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝

import crypto from "crypto";
import fs from "fs";

const key = crypto.randomBytes(32);
fs.writeFileSync(".env", `STUDENT_KEY=${key.toString("hex")}`);

const iv = crypto.randomBytes(12);
const data = fs.readFileSync("students.json");

const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
const tag = cipher.getAuthTag();

fs.writeFileSync("students.enc", encrypted);
fs.writeFileSync("students.iv", iv);
fs.writeFileSync("students.tag", tag);

console.log("Encrypted.");
