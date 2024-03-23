/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const sqs = new AWS.SQS({ region: "ap-northeast-1" });

process.env.TZ = "Asia/Tokyo";

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

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
    let {
        paymentHistoryId,
        token = null,
        cpp,
        cardno,
        expire,
        securitycode,
        holdername
    } = JSON.parse(event.body);

    cpp = uuidCppList[cpp] ? uuidCppList[cpp] : cpp;

    let mysql_con;
    let response = {};

    const { sourceIp = null } = event.requestContext.identity || {};
    let now = Math.floor(new Date().getTime() / 1000);
    const userAgent = event.headers['User-Agent'];

    try {
        const result = await getUserId();
        const { success, userId, bearerToken, statusCode } = result || {};
        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        mysql_con = await mysql.createConnection(writeDbConfig);

        const updatePaymentHistory = `
        UPDATE UserPaymentHistory SET 
        userPaymentHistoryCardNo = ?,
        userPaymentHistoryCardHolderName = ?,
        userPaymentHistoryCardExpired = ?,
        userPaymentHistoryCardCVC = ?,
        userPaymentHistoryPaymentIntent = ?,
        userPaymentHistoryTrackingData = UUID_TO_BIN(?),
        userPaymentHistoryPaymentStartedAt = ?,
        userPaymentHistoryIPAddress4 = ?
        WHERE userPaymentHistoryId = ? AND userPaymentHistoryUserId = ?`;

        const paymentTrackingData = uuidv4();
        now = Math.floor(new Date().getTime() / 1000);

        await mysql_con.execute(updatePaymentHistory, [
            cardno,
            holdername,
            expire,
            securitycode,
            token,
            paymentTrackingData,
            now,
            sourceIp,
            paymentHistoryId,
            userId
        ]);

        //For invalid token or not generate
        if (!token) {
            const updatePaymentHistoryStatusSql = `UPDATE UserPaymentHistory SET userPaymentHistoryStatus = 8 WHERE userPaymentHistoryId = ? AND userPaymentHistoryUserId = ?`;
            await mysql_con.execute(updatePaymentHistoryStatusSql, [paymentHistoryId, userId]);

            const newUserPaymentHistoryId = await createNewPaymentHistory(mysql_con, userId);
            return getResponse({ phi: newUserPaymentHistoryId }, 200);
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

        console.log("cpp", cpp);
        console.log("token", token);
        console.log("amount", amount);

        //Update paument history in DB
        const userInfoQuery = `SELECT userId, userAFCode, userInvitationCode, userEmail FROM User WHERE userId = ?`;
        const [resultUserInfo] = await mysql_con.query(userInfoQuery, userId);

        if (resultUserInfo.length == 0) return getResponse({ message: 'User not found!' }, 404);
        const { userEmail } = resultUserInfo[0] || {}

        const responseData = await paymentTransmission({ bearerToken, paymentHistoryId, pointValue: amount, pointPrice, userEmail });
        console.log('my response data', responseData)

        if (responseData && responseData.data) {
            const { err_code, trans_code, pareq, tds2_url, result } = responseData.data || {};

            //0: Payment NG
            //1: Payment OK (without 3DS pricessing)
            //6: 3DS2.0 processing (redirect to EP screen required)
            //9: System error (missing parameters, fraud, etc.)

            if (['1', '6', 1, 6].includes(result)) {
                response.message = "success";

                //If 3D processing not applicable (Currently this if block is unreachable because 3DS check always enabled only execute else block)
                if (result == 1) {
                    const updatePaymentHistorySql = `
                    UPDATE UserPaymentHistory SET 
                    userPaymentHistoryStatus = 7, 
                    userPaymentHistoryPaymentFinishedAt = ?, 
                    userPaymentHistoryIPAddress2 = ?,
                    userPaymentHistoryUserAgent2 = ?
                    WHERE userPaymentHistoryId = ? AND userPaymentHistoryUserId = ?`;

                    now = Math.floor(new Date().getTime() / 1000);
                    await mysql_con.execute(updatePaymentHistorySql, [now, sourceIp, userAgent, paymentHistoryId, userId]);

                    // 現在のポイント
                    const myPoint = await cluster.get("user:" + ENVID + ":" + userId + ":pt") || 0;
                    console.log("pt", Number(myPoint) + amount);
                    console.log("myPoint", myPoint);
                    // ポイント追加処理
                    await cluster.set("user:" + ENVID + ":" + userId + ":pt", Number(myPoint) + amount);
                    // SQS発行処理
                    // ポイント処理
                    let paymentPattern = 3; // For epsilon credit-card
                    const queueUrl = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/PointSQS-${process.env.ENV}.fifo`;
                    const sqsParams = {
                        MessageBody: JSON.stringify({ userId: userId, point: amount, detailStatus: 1, paymentPattern, executeAt: Math.floor(new Date().getTime() / 1000) }),
                        QueueUrl: queueUrl,
                        MessageGroupId: "POINTSQS_EXECUTE",
                        MessageDeduplicationId: uuidv4(),
                    };
                    const sqsResult = await sqs.sendMessage(sqsParams).promise();
                    if (!sqsResult) {
                        console.error("SQS発行エラー");
                        return getResponse({ message: 'SQS publication error' }, 400);
                    }
                }
                //If 3D processing applicable
                else {
                    const updatePaymentHistorySql = `
                    UPDATE UserPaymentHistory SET 
                    userPaymentHistoryStatus = 5, 
                    userPaymentHistory3DSecureStartedAt = ?,
                    userPaymentHistoryIPAddress2 = ?,
                    userPaymentHistoryUserAgent2 = ?
                    WHERE userPaymentHistoryId = ? AND userPaymentHistoryUserId = ?`;

                    now = Math.floor(new Date().getTime() / 1000);
                    await mysql_con.execute(updatePaymentHistorySql, [now, sourceIp, userAgent, paymentHistoryId, userId]);
                }
            }
            else {
                response.message = "Error occurred.";

                const updatePaymentHistorySql = `UPDATE UserPaymentHistory SET userPaymentHistoryStatus = 6, userPaymentHistoryErrorCode = ? WHERE userPaymentHistoryId = ? AND userPaymentHistoryUserId = ?`;
                await mysql_con.execute(updatePaymentHistorySql, [err_code, paymentHistoryId, userId]);

                response.phi = await createNewPaymentHistory(mysql_con, userId);
            }

            response.errorCode = err_code;
            response.transCode = trans_code;
            response.pareq = pareq;
            response.tds2URL = tds2_url;
            response.result = result;
            response.amount = amount;
            response.trackingUUID = paymentTrackingData;

            return getResponse(response, 200);
        }

        //Failed to create transaction
        response.message = "Failure!";

        return getResponse(response, 400);
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

            return { success: true, userId, bearerToken: event.headers.Authorization, statusCode: 200 }
        }
        // ログインしていない
        console.error("ログインしていない");
        return { success: false, statusCode: 101 }
    }

    async function paymentTransmission(param = {}) {
        console.log("process.env.ENV", process.env.ENV);
        const url = process.env.ENV == 'cardel-product' ? 'https://epsilon.cardel.online/cardel-payment/' : 'https://epsilon.cardel.online/cardel-payment-develop/';

        try {
            const axiosConfig = {
                headers: {
                    'Authorization': param.bearerToken,
                    'User-Agent': userAgent,
                    'Content-Type': 'application/json'
                }
            }

            const postData = {
                paymentHistoryId: param.paymentHistoryId,
                pointValue: param.pointValue,
                pointPrice: param.pointPrice,
                userEmail: param.userEmail,
                cardno,
                expire,
                securitycode,
                holdername,
                token,
                cpp
            }

            const response = await axios.post(url, postData, axiosConfig);

            console.log('loppppp', response)

            return response.data;
        } catch (error) {
            console.log('Service not available. Check the server is running state')
            console.error(`Request error:`, error);
            throw new Error(400);
        }
    }

    async function createNewPaymentHistory(mysql_con, userId) {
        //Create a new payment history
        const sourcePaymentHistoryInfoSql = `SELECT * FROM UserPaymentHistory WHERE userPaymentHistoryId = ? AND userPaymentHistoryUserId = ? LIMIT 0, 1`;
        const [sourcePaymentHistoryInfo] = await mysql_con.query(sourcePaymentHistoryInfoSql, [paymentHistoryId, userId]);

        const {
            userPaymentHistoryPaymentPointId,
            userPaymentHistoryPaymentPoint,
            userPaymentHistoryAFCode,
            userPaymentHistoryInvitationCode,
        } = sourcePaymentHistoryInfo[0] || {};

        const createNewPaymentHistorySql = `
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
        userPaymentHistoryUserAgent1
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        now = Math.floor(new Date().getTime() / 1000);

        const [insertPaymentResult] = await mysql_con.query(createNewPaymentHistorySql, [
            userId,
            now,
            userPaymentHistoryPaymentPointId,
            userPaymentHistoryPaymentPoint,
            userPaymentHistoryAFCode,
            userPaymentHistoryInvitationCode,
            3,
            3,
            sourceIp,
            userAgent,
        ]);

        const { insertId } = insertPaymentResult;

        return insertId;
    }
};