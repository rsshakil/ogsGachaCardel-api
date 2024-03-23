/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const bcrypt = require("bcryptjs");

process.env.TZ = "Asia/Tokyo";


const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;
/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
 */
exports.handler = async (event) => {
    console.log("Event data:", event);
    // Reading encrypted environment variables --- required
    if (process.env.DBINFO == null) {
        const ssmreq = {
            Name: 'PS_' + process.env.ENV,
            WithDecryption: true
        };
        const ssmparam = await ssm.getParameter(ssmreq).promise();
        const dbinfo = JSON.parse(ssmparam.Parameter.Value);
        process.env.DBWRITEENDPOINT = dbinfo.DBWRITEENDPOINT;
        process.env.DBREADENDPOINT = dbinfo.DBREADENDPOINT;
        process.env.DBUSER = dbinfo.DBUSER;
        process.env.DBPASSWORD = dbinfo.DBPASSWORD;
        process.env.DBDATABSE = dbinfo.DBDATABSE;
        process.env.DBPORT = dbinfo.DBPORT;
        process.env.DBCHARSET = dbinfo.DBCHARSET;
        process.env.DBINFO = true;
        process.env.REDISPOINT1 = dbinfo.REDISPOINT1;
        process.env.REDISPOINT2 = dbinfo.REDISPOINT2;
        process.env.ENVID = dbinfo.ENVID;
        process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
    }
    const ENVID = process.env.ENVID;
    // Database info
    const writeDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };
    const redisConfig = [
        {host: process.env.REDISPOINT1, port: 6379},
        {host: process.env.REDISPOINT2, port: 6379}
    ];
    const cluster = new redis.Cluster(
        redisConfig, 
        {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: {tls: true}        
        }
    );
    let {
        oldPassword,
        newPassword1,
        newPassword2
    } = JSON.parse(event.body);

    let mysql_con;
    let response = {};

    try {
        // jwtからユーザーIDを取得
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};
        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);
        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);
        // check & get target user info
        const read_sql = `SELECT userId, userPassword FROM User WHERE userId = ? LIMIT 1`;
    
        const [read_query_result] = await mysql_con.execute(read_sql, [userId]);
        if (read_query_result.length < 1) {
            // Not found user
            throw new Error(101);
        }
        const userInfo = read_query_result[0];

        const passwordComparedResult = await bcrypt.compare(oldPassword, userInfo.userPassword);

        if (!passwordComparedResult) {
            // Not match old password
            throw new Error(102);
        }
        if (newPassword1 !== newPassword2) {
            // New password not match
            throw new Error(103);
        }
        if (oldPassword === newPassword1) {
            // Old password should not same new password
            throw new Error(104);
        }
        // パスワードチェック
        if(!newPassword1.match(/^([ -~]{6,32})+$/)) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify({
                    errorCode: 109,
                    message: "password regex error"
                }),
            }
        }

        const hashedPassword = await bcrypt.hashSync(newPassword1, 10);
        const updatedAt = Math.floor(new Date().getTime() / 1000);

        const update_sql = `UPDATE User SET userPassword = ?, userUpdatedAt = ? WHERE userId = ?`;
        const sql_param = [
            hashedPassword,
            updatedAt,
            userId
        ];
        const [query_result] = await mysql_con.execute(update_sql, sql_param);

        response = {
            message: "success"
        };
        return getResponse(response, 200);
    } catch (error) {
        if (mysql_con) await mysql_con.rollback();
        console.error("error:", error)
        response = {
            errorCode: Number(error.message)
        }
        return getResponse(response, 400);
    } finally {
        if (mysql_con) await mysql_con.close();
    }

    function getResponse(data, statusCode = 200) {
        return {
            statusCode,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify(data),
        }
    }

    async function getUserId() {
        // ログインしている必要あり
        if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null") {
            // トークン
            const token = jwtPattern.exec(event.headers.Authorization)[1];
            console.log("token", token);
            const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
            if (decoded == null) {
                console.error("JWTが解析できない");
                return { success: false, statusCode: 103 }
            }
            console.log("decoded", decoded);
            let userId = decoded.userId;

            return { success: true, userId, statusCode: 200 }
        }
        // ログインしていない
        console.error("ログインしていない");
        return { success: false, statusCode: 101 }
    }

};