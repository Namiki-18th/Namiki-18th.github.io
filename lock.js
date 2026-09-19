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
const keyHex = key.toString("hex");

// .env ファイルを安全に書き換える処理
const envFilePath = ".env";
let envContent = "";

if (fs.existsSync(envFilePath)) {
    envContent = fs.readFileSync(envFilePath, "utf8");
}

const envRegex = /^STUDENT_KEY=.*$/m;
if (envRegex.test(envContent)) {
    // 既存の STUDENT_KEY があれば置換する
    envContent = envContent.replace(envRegex, `STUDENT_KEY=${keyHex}`);
} else {
    // 存在しなければ末尾に追記する
    if (envContent.length > 0 && !envContent.endsWith("\n")) {
        envContent += "\n";
    }
    envContent += `STUDENT_KEY=${keyHex}\n`;
}

fs.writeFileSync(envFilePath, envContent);

// 暗号化処理
const iv = crypto.randomBytes(12);
const data = fs.readFileSync("students.json");

const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
const tag = cipher.getAuthTag();

fs.writeFileSync("students.enc", encrypted);
fs.writeFileSync("students.iv", iv);
fs.writeFileSync("students.tag", tag);

console.log("Encrypted.");