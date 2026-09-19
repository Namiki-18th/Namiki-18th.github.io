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
const path = require("path");
require("dotenv").config();

if (!/^[0-9a-f]{64}$/i.test(process.env.STUDENT_KEY || "")) {
    throw new Error("STUDENT_KEY must be a 32-byte hexadecimal key");
}
const key = Buffer.from(process.env.STUDENT_KEY, "hex");
const dataPath = (fileName) => path.join(__dirname, fileName);

let students = {};

function loadStudents() {
    try {
        const iv = fs.readFileSync(dataPath("students.iv"));
        const tag = fs.readFileSync(dataPath("students.tag"));
        const encrypted = fs.readFileSync(dataPath("students.enc"));
        if (iv.length !== 12 || tag.length !== 16) {
            throw new Error("Invalid encrypted student data metadata");
        }
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);

        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);

        students = JSON.parse(decrypted.toString("utf8"));
    } catch (err) {
        console.error("[System] 名簿データの読み込みに失敗しました。:", err.message);
        students = {};
    }
}

// 初期読み込み
loadStudents();

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

function getAllStudents() {
    return students;
}

function updateStudents(newStudentsData) {
    students = newStudentsData;
    const dataBuffer = Buffer.from(JSON.stringify(students), "utf8");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    
    const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();

    fs.writeFileSync(dataPath("students.iv"), iv);
    fs.writeFileSync(dataPath("students.tag"), tag);
    fs.writeFileSync(dataPath("students.enc"), encrypted);
}

module.exports = {
    getName,
    getStudentNumber,
    getAllStudents,
    updateStudents
};