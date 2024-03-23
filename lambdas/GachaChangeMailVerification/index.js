/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk');
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

/**
 * GachaChangeMailVerification.
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

    // Database info
    const readDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };

    let mysqlCon;
    let response;

    try {
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};

        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        // mysql connect
        mysqlCon = await mysql.createConnection(readDbConfig);
        const { token } = JSON.parse(event.body);
        console.log("token from body", token);
        if (!token) throw new Error("invalid parameter");
        const now = Math.floor((new Date(Date.now()).getTime()) / 1000);
        const updatedAt = Math.floor(new Date().getTime() / 1000);
        const tokenCheckSQL = `SELECT userId FROM User WHERE userRegistExpiredAt >= ? AND userRegistToken = ?`;
        const [readResult] = await mysqlCon.query(tokenCheckSQL, [now, token]);
        // トークンが正しく有効期限以内
        if (readResult && readResult[0] && readResult[0].userId >= 1 && userId==readResult[0].userId) {
            // Userデータの更新
            const updateSql = `UPDATE User SET userEmail = userNewEmail, userRegistExpiredAt = NULL, userRegistToken = NULL, userNewEmail = NULL,userUpdatedAt = ? WHERE userId = ?`;
            const [updateResult] = await mysqlCon.query(updateSql, [updatedAt, readResult[0].userId]);
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify(response),
            };
        }
        else {
            throw new Error("invalid token");
        }
    } catch (error) {
        console.error("error:", error);
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify({
                errorCode: 503,
                message: error
            }),
        };
    } finally {
        if (mysqlCon) await mysqlCon.close();
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