/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

const sqs = new AWS.SQS();
const queueUrl = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/PointSQS-${process.env.ENV}.fifo`;


/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
 */
exports.handler = async (event, context, callback) => {
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

    const { giftCards } = JSON.parse(event.body);
    const now = Math.floor(new Date().getTime() / 1000);

    let mysql_con;
    let response = {};

    try {
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};

        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);
        await mysql_con.beginTransaction();
        // const { queryStringParameters = null, pathParameters = null } = event || {};

        //1. check is present available
        const present_query = `
        SELECT 
            presentId,
            userPresentId,
            presentPoint
        FROM Present 
        JOIN UserPresent ON userPresentPresentId = presentId
        WHERE userPresentId = ? AND userPresentExpiredAt >= ? AND userPresentFlag = 0
        LIMIT 0, 1`;

        console.log('present_query >>>', present_query)
        for (let i = 0; i < giftCards.length; i++) {
            const userPresentId = giftCards[i].userPresentId;
            console.log('present_query params >>>', [userPresentId, now])
            const [present_result] = await mysql_con.query(present_query, [userPresentId, now]);

            if (present_result.length > 0) {
                const { presentId, userPresentId, presentPoint } = present_result[0];

                //Update UserPresent
                const user_present_update_query = `UPDATE UserPresent SET userPresentFlag = ?, userPresentUsedAt = ? WHERE userPresentId = ? AND userPresentUserId = ?`;
                await mysql_con.query(user_present_update_query, [1, now, userPresentId, userId]);

                //Update/Create user point => UserPoint
                const user_point_query = `SELECT * FROM UserPoint WHERE userPointUserId = ? LIMIT 0, 1`;
                const [user_point_result] = await mysql_con.query(user_point_query, [userId]);

                //Update existing point
                /*
                    if (user_point_result.length > 0) {
                        const user_pont_update_query = `UPDATE UserPoint SET userPointNotPurchasePoint = userPointNotPurchasePoint + ? WHERE userPointUserId = ?`;
                        await mysql_con.query(user_pont_update_query, [presentPoint, userId]);
                    }
                    //Create new point record
                    else {
                        const user_pont_insert_query = `INSERT INTO UserPoint (userPointUserId, userPointNotPurchasePoint) VALUES (?, ?) `;
                        await mysql_con.query(user_pont_insert_query, [userId, presentPoint]);
                    }
                */

                //SQS Processing
                const params = {
                    MessageBody: JSON.stringify({ userId: userId, presentId, point: presentPoint, detailStatus: 6, executeAt: Math.floor(new Date().getTime() / 1000) }),
                    QueueUrl: queueUrl,
                    MessageGroupId: "POINTSQS_EXECUTE",
                    MessageDeduplicationId: uuidv4()
                };
                await sqs.sendMessage(params).promise();
                console.log("Message published successfully");
                // callback(null, "Message published successfully");

                //update user redis data 
                const redisKeyUserPoint = `user:${ENVID}:${userId}:pt`;
                await cluster.incrby(redisKeyUserPoint, presentPoint);
            }
            else {
                //Present not Available to use
                return getResponse({ message: 'This present has already taken or expired' }, 400);
            }
        }

        await mysql_con.commit();

        return getResponse({ message: 'success' }, 200);

    } catch (error) {
        console.error("error:", error)
        await mysql_con.rollback();
        // callback(error);
        return getResponse(error, 400);
    } finally {
        if (mysql_con) await mysql_con.close();

        try {
            cluster.disconnect();
        }
        catch (e) {
            console.log("finally error", e);
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