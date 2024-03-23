/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const lambda = new AWS.Lambda();
const crypto = require("crypto");
const redis = require('ioredis');

process.env.TZ = "Asia/Tokyo";

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
        process.env.FORGETMAILURL = dbinfo.FORGETMAILURL;
        process.env.MAILFROM = dbinfo.MAILFROM;
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
    const forgetMailUrl = process.env.FORGETMAILURL;

    let {
        mailAddress,
        token
    } = JSON.parse(event.body);

    let mysql_con;
    let response = {};

    try {
        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);

        // No mailAddress
        if (!mailAddress) {
            throw new Error(101);
        }

        // check & get target user info
        const read_sql = `SELECT userId FROM User WHERE userEmail = ? LIMIT 1`;
    
        const [read_query_result] = await mysql_con.execute(read_sql, [mailAddress]);
        if (read_query_result.length < 1) {
            // Not found user
            throw new Error(101);
        }
        const userInfo = read_query_result[0];

        if (!token) {
            // No token
            throw new Error(102);
        }

        const update_sql = `
            UPDATE 
                User 
            SET 
                userForgetMailToken = ?,
                userForgetMailExpiredAt = ?,
                userRegistToken = ? 
            WHERE userId = ?
        `;

        const userForgetMailExpiredAt = Math.floor(new Date().getTime() / 1000 ) + 15 * 60; // Adding 15 minutes in seconds
        const userRegistToken = randomString(128);
        
        const sql_param = [
            token,
            userForgetMailExpiredAt,
            userRegistToken,
            userInfo.userId
        ];
        const [query_result] = await mysql_con.execute(update_sql, sql_param);

        // メールを発行
        
        const emailTemplateFrom = await cluster.get("system:"+ENVID+":msm");
        let mailSubjectFromRedis = await cluster.get("system:"+ENVID+":mfpt");//mailTitle
        let mailBodyFromRedis = await cluster.get("system:"+ENVID+":mfpb");//mailBody
        let mailBodyAfterReplaceUrl = mailBodyFromRedis.replaceAll("{%URL%}",`${forgetMailUrl + "?token=" + userRegistToken}`);

        console.log("emailTemplateFrom",emailTemplateFrom);
        console.log("mailSubjectFromRedis",mailSubjectFromRedis);
        console.log("mailBodyAfterReplaceUrl",mailBodyAfterReplaceUrl);

        await exports.sendEmail(mailAddress, mailSubjectFromRedis, mailBodyAfterReplaceUrl, emailTemplateFrom);

        response = {
            message: "success"
        };
        return getResponse(response, 200);
    } catch (error) {
        if (mysql_con) await mysql_con.rollback();
        console.error("error:", error)
        response = {
            // errorCode: Number(error.message)
            message: "success"
        }
        //return getResponse(response, 400);
        return getResponse(response, 200);
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
};

function randomString(len){
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomArr = new Uint32Array(new Uint8Array(crypto.randomBytes(len * 4)).buffer);
    return [...randomArr].map(n => chars.charAt(n % chars.length)).join('');
}

exports.sendEmail = async (to, subject, body, source) => {
    console.log("==================== email")
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