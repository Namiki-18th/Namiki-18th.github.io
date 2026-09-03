//＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝
//もし君がハッカーに憧れてstudent.jsonを解析しようとしているならやめておきな。
//君が115792089237316195423570985008687907853269984665640564039457584007913129639936回の総当たりをできるなら話は別だけど。
//
//If you're looking at this script and thinking about parsing student.json, 
//don't bother—unless you're prepared to run a brute-force attack involving
// 115792089237316195423570985008687907853269984665640564039457584007913129639936 iterations.
//＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝

const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();
const key = Buffer.from(process.env.STUDENT_KEY, "hex");
const iv = fs.readFileSync("students.iv");
const tag = fs.readFileSync("students.tag");
const encrypted = fs.readFileSync("students.enc");
const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);

const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
]);

const students = JSON.parse(decrypted.toString("utf8"));
function getName(studentNumber) {
    return students[studentNumber] || "不明";
}

function getStudentNumber(name) {
    for (const [studentNumber, studentName] of Object.entries(students)) {
        if (studentName === name) {
            return studentNumber;
        }
    }
    return "不明";
}

module.exports = {
    getName,
    getStudentNumber
};