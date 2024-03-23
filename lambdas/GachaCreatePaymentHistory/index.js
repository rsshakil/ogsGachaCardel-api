/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

process.env.TZ = "Asia/Tokyo";

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;
const sqs = new AWS.SQS();


const mapperObj = {
    EPSILON_CREDIT_CARD: { historyStatus: 3, paymentPattern: 3 },
    PAYPAY: { historyStatus: 12, paymentPattern: 6 },
}

/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
 */
exports.handler = async (event) => {
    console.log("Event data:", event);
    // Reading encrypted environment variables --- required
    // if (process.env.DBINFO == null) {
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
    // }
    const ENVID = process.env.ENVID;
    const DIRECTION = (process.env.DIRECTION) ? process.env.DIRECTION : 1;
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
            slotsRefreshTimeout: 10000,
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: { tls: true }
        }
    );

    let { cpp, paymentPattern = 'EPSILON_CREDIT_CARD', browserUUID, browserUserAgent, appRendersDateTime } = JSON.parse(event.body);

    let mysql_con;
    let response = {};
    const uuidCppList = {
        "550e8400-e29b-41d4-a717-446655440000": 1,
        "550e8400-e29b-41d4-a717-446655440001": 2,
        "550e8400-e29b-41d4-a717-446655440002": 3,
        "550e8400-e29b-41d4-a717-446655440003": 4,
        "550e8400-e29b-41d4-a717-446655440004": 5,
        "550e8400-e29b-41d4-a717-446655440005": 6,
        "550e8400-e29b-41d4-a717-446655440006": 7,
        "550e8400-e29b-41d4-a717-446655440007": 8,
    }

    try {
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};
        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        mysql_con = await mysql.createConnection(writeDbConfig);
        //check cpp is uuid then replace it to equvalent id
        cpp = uuidCppList[cpp] ? uuidCppList[cpp] : cpp;
        console.log("cpppppppp", cpp);
        //check cpp exists or not in db
        const pointInfoQuery = `SELECT pointPrice FROM Point WHERE pointId = ? AND pointStatus = ?`;
        const [resultPointInfo] = await mysql_con.query(pointInfoQuery, [cpp, 1]);

        //checkPointInfo 
        if (resultPointInfo.length == 0) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify({
                    errorCode: 405
                }),
            }
        }

        // 購入商品の取得
        const redisPointData = await cluster.lrange("point:" + process.env.ENVID + ":list", 0, -1);
        const convertedObject = redisPointData.reduce((acc, item) => {
            const parsedItem = JSON.parse(item);
            acc[parsedItem.pointId] = parsedItem;
            return acc;
        }, {});

        const pointId = cpp;
        const { pointValue: amount = 0, pointPrice = 0 } = convertedObject[pointId] || {};

        //Create paument history in DB
        const userInfoQuery = `SELECT userId, userAFCode, userInvitationCode, userEmail FROM User WHERE userId = ?`;
        const [resultUserInfo] = await mysql_con.query(userInfoQuery, userId);

        if (resultUserInfo.length == 0) return getResponse({ message: 'User not found!' }, 404);
        const { userAFCode, userInvitationCode, userEmail } = resultUserInfo[0] || {}

        const insertPaymentHistory = `
            INSERT INTO UserPaymentHistory(
                userPaymentHistoryUserId, 
                userPaymentHistoryCreatedAt, 
                userPaymentHistoryPaymentPointId, 
                userPaymentHistoryPaymentPoint, 
                userPaymentHistoryAFCode, 
                userPaymentHistoryInvitationCode,
                userPaymentHistoryStatus,
                userPaymentHistoryPaymentPattern,
                userPaymentHistoryIPAddress1,
                userPaymentHistoryUserAgent1,
                userPaymentHistoryBrowserUUID,
                userPaymentHistoryBrowserUserAgent,
                userPaymentHIstoryUserAppRendersAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        let now = Math.floor(new Date().getTime() / 1000);
        const { sourceIp = null } = event.requestContext.identity || {};
        const userAgent = event.headers['User-Agent'];

        const params = [
            userId,
            now,
            pointId,
            amount,
            userAFCode,
            userInvitationCode,
            mapperObj[paymentPattern].historyStatus,
            mapperObj[paymentPattern].paymentPattern,
            sourceIp,
            userAgent,
            browserUUID,
            browserUserAgent,
            appRendersDateTime
        ];

        const [insertPaymentResult] = await mysql_con.query(insertPaymentHistory, params);

        const { insertId: userPaymentHistoryId } = insertPaymentResult;

        response = { message: 'success', paymentHistoryId: userPaymentHistoryId }

        return getResponse(response, 200);

    }
    catch (e) {
        console.log(e.message);
        response = {
            message: e.message
        };
        return getResponse(response, 400);
    }
    finally {
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