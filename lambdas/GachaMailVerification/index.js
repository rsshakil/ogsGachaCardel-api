/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const lambda = new AWS.Lambda();
process.env.TZ = "Asia/Tokyo";
/**
 * GachaMailVerification.
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
        process.env.MAILFROM = dbinfo.MAILFROM;
    }
    const ENVID = process.env.ENVID;
    // Database info
    const readDbConfig = {
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

    let parameter = [];
    let mysql_con;
    let response;

    try {
        // mysql connect
        mysql_con = await mysql.createConnection(readDbConfig);
         const { token } = JSON.parse(event.body);
        console.log("token from body",token);
        if (!token) throw new Error("invalid parameter"); 
        const now = Math.floor((new Date(Date.now()).getTime()) / 1000);
        const tokenCheckSQL = `SELECT userId, userEmail, userCountryId, userRegistFlag FROM User WHERE userStatus = 1 AND userRegistExpiredAt >= ? AND userRegistToken = ?`;
        const [query1] = await mysql_con.query(tokenCheckSQL, [now, token]);
        // トークンが正しく有効期限以内
        if (query1 && query1[0] && query1[0].userId >= 1) {


            if(query1[0].userRegistFlag==1){
                return {
                    statusCode: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': '*',
                    },
                    body: JSON.stringify(response),
                }
            }


            // Userデータの更新　
            // 1. 本登録にする　トークンを削除する
            const registSQL = `UPDATE User SET userRegistFlag = 1 WHERE userId = ?`;//userRegistToken = NULL AND , userRegistExpiredAt = NULL remove from updateSql acording to instruction.
            const [query2] = await mysql_con.query(registSQL, [query1[0].userId]);
            // 2. Redisのデータを作成する
            const userStatus = {
                s : 1,
                bf : 1
            }
            await cluster.set("user:" + ENVID + ":" + query1[0].userId + ":pt", 0);
            await cluster.set("user:" + ENVID + ":" + query1[0].userId + ":country", query1[0].userCountryId);
            await cluster.set("user:" + ENVID + ":" + query1[0].userId + ":status", JSON.stringify(userStatus) );
            // 本登録完了メールを送信する
            const emailTemplateFrom = await cluster.get("system:"+ENVID+":msm");
            let mailSubjectFromRedis = await cluster.get("system:"+ENVID+":mrct");//mailTitle
            let mailBodyFromRedis = await cluster.get("system:"+ENVID+":mrcb");//mailBody

            console.log("emailTemplateFrom",emailTemplateFrom);
            console.log("mailSubjectFromRedis",mailSubjectFromRedis);
            console.log("mailBodyFromRedis",mailBodyFromRedis);

            await exports.sendEmail(query1[0].userEmail, mailSubjectFromRedis, mailBodyFromRedis, emailTemplateFrom);

            // 事前登録プレゼント情報の取得 presentStatus = 1の場合実行する
            const presentId = 1;
            const presentReadSql = `SELECT presentDeadLineTypeId, presentDeadlineAt, presentDeadlineDays FROM Present WHERE presentId = ? AND presentStatus = 1`;
            const [query3] = await mysql_con.query(presentReadSql, [presentId]);
            if (query3 && query3.length >= 1) {
                const presentDeadLineTypeId = query3[0].presentDeadLineTypeId;
                const presentDeadlineAt = query3[0].presentDeadlineAt;
                const presentDeadlineDays = query3[0].presentDeadlineDays;
                let deadlineAt = 0;
                if (presentDeadLineTypeId == 1) {
                    deadlineAt = presentDeadlineAt;
                }
                else {
                    let unix1 = now + (60 * 60 * 24 * presentDeadlineDays);
                    let unix1Date = new Date(unix1 * 1000);
                    console.log("unix1Date", unix1Date);
                    console.log("unix1Date.getFullYear()", unix1Date.getFullYear());
                    console.log("unix1Date.getMonth()", unix1Date.getMonth());
                    console.log("unix1Date.getDate()", unix1Date.getDate());
                    let presentLimitDate = Math.floor(new Date( unix1Date.getFullYear(), unix1Date.getMonth(), unix1Date.getDate(), 23, 59, 59 ) / 1000);
                    deadlineAt = presentLimitDate;
                }
                const presentInsertSql = `INSERT INTO UserPresent(userPresentUserId, userPresentPresentId, userPresentFlag, userPresentCreatedAt, userPresentExpiredAt) VALUES(?, ?, ?, ?, ?)`;
                const [query4] = await mysql_con.query(presentInsertSql, [query1[0].userId, presentId, 0, now, deadlineAt]);
            }

            // ユーザーポイントの追加
            const ppointInsertSql = `INSERT IGNORE INTO UserPoint(userPointUserId) VALUES(?)`;
            const [query5] = await mysql_con.query(ppointInsertSql, [query1[0].userId]);
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify(response),
            }
        }
        else {
            throw new Error("invalid token");
        }
    } catch (error) {
        console.error("error:", error)
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
        }
    } finally {
        if (mysql_con) await mysql_con.close();
        try {
            cluster.disconnect();
        }
        catch (e) {
            console.log("finally error", e);
        }
    }
};

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