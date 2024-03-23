/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk');
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const lambda = new AWS.Lambda();
const crypto = require("crypto");
const redis = require('ioredis');

const jwt = require('jsonwebtoken');
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

/**
 * GachaUserMailUpdate.
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
        process.env.REGISTURL = dbinfo.REGISTURL;
        process.env.CHANGEMAILURL = dbinfo.CHANGEMAILURL;
        process.env.MAILFROM = dbinfo.MAILFROM;
        process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
    }

    // Database info
    const writeDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };

    const ENVID = process.env.ENVID;
    const redisConfig = [
        { host: process.env.REDISPOINT1, port: 6379 },
        { host: process.env.REDISPOINT2, port: 6379 }
    ];
    const cluster = new redis.Cluster(
        redisConfig,
        {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: { tls: true }
        }
    );

    const changeMailURL = process.env.CHANGEMAILURL;

    let mysqlCon;
    let response = {};

    // ユーザーメールアドレス変更処理
    // 1. リクエストパラメータをチェック
    // 2. データベースを更新（新メールアドレス変更状態）
    // 3. 新メールアドレスに本登録メールを発行（送信）
    let {
        newEmailAddress
    } = JSON.parse(event.body);

    try {
        // check request parameter
        if (newEmailAddress === null) {
            return getResponse({ message: 'Invalid parameters' }, statusCode);
        }
        console.log("newEmailAddress1", "'" + newEmailAddress + "'");
        newEmailAddress = newEmailAddress.trim();
        console.log("newEmailAddress2", "'" + newEmailAddress + "'");
        // jwtからユーザーIDを取得
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};
        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        // mysql connect
        mysqlCon = await mysql.createConnection(writeDbConfig);

        // check & get target user info
        const readSql = `SELECT userId FROM User WHERE userId = ? LIMIT 1`;

        const [readResult] = await mysqlCon.execute(readSql, [userId]);
        if (readResult.length < 1) {
            // Not found user
            throw new Error(101);
        }

        // check exists new email address
        const existsEmailSql = `SELECT userId FROM User WHERE userEmail = ? LIMIT 1`;

        const [existsEmailResult] = await mysqlCon.execute(existsEmailSql, [newEmailAddress]);
        if (existsEmailResult.length > 0) {
            // Do nothing
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify(response),
            };
        }

        // 有効期限とトークン、新メールアドレスを更新
        const updateSQL = `UPDATE User SET userRegistExpiredAt = ?, userRegistToken = ?, userNewEmail = ?, userUpdatedAt = ?, userUpdatedBy = ? WHERE userId = ?`;

        const updatedAt = Math.floor(new Date().getTime() / 1000);
        const expiredAt = Math.floor(new Date().getTime() / 1000 ) + (60 * 60 * 24); // １日後
        const token = randomString(128);

        let updateParam = [
            expiredAt,
            token,
            newEmailAddress,
            updatedAt,
            '本人',
            userId
        ];

        const [updateResult] = await mysqlCon.execute(updateSQL, updateParam);

        // メールを発行
        const emailTemplateFrom = await cluster.get("system:"+ENVID+":msm");
        let mailSubjectFromRedis = await cluster.get("system:"+ENVID+":mcmt");//mailTitle
        let mailBodyFromRedis = await cluster.get("system:"+ENVID+":mcmb");//mailBody
        let mailBodyAfterReplaceUrl = mailBodyFromRedis.replaceAll("{%URL%}",`${changeMailURL}?token=${token}`);

        console.log("emailTemplateFrom",emailTemplateFrom);
        console.log("mailSubjectFromRedis",mailSubjectFromRedis);
        console.log("mailBodyAfterReplaceUrl",mailBodyAfterReplaceUrl);

        await exports.sendEmail(newEmailAddress, mailSubjectFromRedis, mailBodyAfterReplaceUrl, emailTemplateFrom);
        console.log('my response', response);
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify(response),
        };
    } catch (error) {
        console.error("error:", error);
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify({
                errorCode: 501,
                message: "user create error"
            }),
        };
    } finally {
        if (mysqlCon) await mysqlCon.close();
    }

    function getResponse(data, statusCode = 200) {
        return {
            statusCode,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify(data),
        };
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
                return { success: false, statusCode: 103 };
            }
            console.log("decoded", decoded);
            let userId = decoded.userId;

            return { success: true, userId, statusCode: 200 };
        }
        // ログインしていない
        console.error("ログインしていない");
        return { success: false, statusCode: 101 };
    }
};

function randomString(len){
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomArr = new Uint32Array(new Uint8Array(crypto.randomBytes(len * 4)).buffer);
    return [...randomArr].map(n => chars.charAt(n % chars.length)).join('');
}

exports.sendEmail = async (to, subject, body, source) => {
    console.log("==================== email");
    // E-mail setting
    let emailParams = {
        Destination: {
            ToAddresses: [to],
        },
        Message: {
            Subject: { Data: subject },
            Body: {
                Text: { Data: body },
            }
        },
        Source: source
    };

    let payload = JSON.stringify(emailParams);
    console.log(payload);
    let invokeParams = {
        FunctionName: "sendMail-" + process.env.ENV,
        InvocationType: "Event",
        Payload: payload
    };
    // invoke lambda
    let result = await lambda.invoke(invokeParams).promise();
    // console.log("==========result", result)
    if (result.$response.error) throw (500, result.$response.error.message);

    return result;
};