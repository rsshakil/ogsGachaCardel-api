/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const SqsExtendedClient = require('sqs-extended-client');

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

const sqs = new AWS.SQS();
const queueUrl = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/PointSQS-${process.env.ENV}.fifo`;
const queueUrl2 = `https://sqs.ap-northeast-1.amazonaws.com/225702177590/InventorySQS-${process.env.ENV}.fifo`;

const DEFAULT_MESSAGE_SIZE_THRESHOLD = 262144; //bytes
const extendedClient = new SqsExtendedClient({
    bucketName: `sqs-message-payloads-${process.env.ENV}`,
    messageSizeThreshold: DEFAULT_MESSAGE_SIZE_THRESHOLD
});

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

    let { userCollectionId = [], pattern, userShippingId, userShippingSMSToken } = JSON.parse(event.body);
    const now = Math.floor(new Date().getTime() / 1000);

    console.log("xxxx-----0");
    // console.log("userCollectionId", userCollectionId);
    // console.log("pattern", pattern);
    // console.log("userShippingId", userShippingId);

    let mysql_con;
    let response = {};

    try {
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};

        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);

        const sourceIP = (event.requestContext.identity.sourceIp) ? event.requestContext.identity.sourceIp : '';
        console.log("sourceIP", sourceIP);

        //if (userCollectionId.length == 0) return getResponse({errorCode: 101 }, 400);

        //Point conversion process
        // コレクションのポイント化
        if (pattern == 1) {
            if (userCollectionId.length == 0) return getResponse({ message: 'success' }, 200);

            //Check userCollectionId is for allCollection
            if (userCollectionId === "all") {
                //getAll userCollections userCollectionId
                // コレクションデータ
                const collectionSql = `SELECT userCollectionId FROM UserCollection WHERE userCollectionUserId = ? and userCollectionEmissionId > ? ORDER BY userCollectionCreatedAt`;
                console.log("userId", userId);
                const [userCollectionData] = await mysql_con.query(collectionSql, [userId, 0]);
                console.log("data length", userCollectionData.length);
                if (userCollectionData.length == 0) return getResponse({ message: 'success' }, 200);
                userCollectionId = userCollectionData.map(row => row.userCollectionId);
            }

            //Get matching records
            const user_collention_match_query = `
            SELECT *
            FROM UserCollection 
            WHERE userCollectionUserId = ? AND userCollectionStatus = ? AND userCollectionExpiredAt >= ? AND  userCollectionId IN (?)`;

            console.log("userCollectionUserId", userId);
            console.log("now", now);
            console.log("userCollectionId", userCollectionId);

            const [collection_match_result] = await mysql_con.query(user_collention_match_query, [userId, 1, now, userCollectionId]);
            // データがなければ終了
            if (collection_match_result.length == 0) return getResponse({ errorCode: 102 }, 400);

            const userCollectionIds = collection_match_result.map(x => x.userCollectionId);
            const emissionItemIds = collection_match_result.map(x => x.userCollectionItemId);

            await mysql_con.beginTransaction();

            // ポイントの合計を算出
            const userCollectionPoint = collection_match_result.reduce((acc, item) => {
                return acc + item.userCollectionPoint;
            }, 0);

            //Update/Create user point => UserPoint
            // const user_point_query = `SELECT * FROM UserPoint WHERE userPointUserId = ? LIMIT 0, 1`;
            // const [user_point_result] = await mysql_con.query(user_point_query, [userId]);

            //Update existing point

            // if (user_point_result.length > 0) {
            // const user_pont_update_query = `UPDATE UserPoint SET userPointExchangePoint = userPointExchangePoint + ? WHERE userPointUserId = ?`;
            // await mysql_con.query(user_pont_update_query, [userCollectionPoint, userId]);
            // }
            //Create new point record
            // else {
            // const user_pont_insert_query = `INSERT INTO UserPoint (userPointUserId, userPointExchangePoint) VALUES (?, ?) `;
            // await mysql_con.query(user_pont_insert_query, [userId, userCollectionPoint]);
            // }

            //delete the target only matching collection data
            const delete_collection_query = `DELETE FROM UserCollection WHERE userCollectionId IN (?)`;
            await mysql_con.query(delete_collection_query, [userCollectionIds]);

            //SQS Processing
            const params = {
                MessageBody: JSON.stringify({ userId: userId, point: userCollectionPoint, detailStatus: 3, executeAt: Math.floor(new Date().getTime() / 1000) }),
                QueueUrl: queueUrl,
                MessageGroupId: "POINTSQS_EXECUTE",
                MessageDeduplicationId: uuidv4()
            };
            await sqs.sendMessage(params).promise();
            console.log("Message published successfully");

            //update user redis data 
            const redisKeyUserPoint = `user:${ENVID}:${userId}:pt`;
            await cluster.incrby(redisKeyUserPoint, userCollectionPoint);

            // 在庫変動をSQSに
            const params2 = {
                MessageBody: JSON.stringify({ itemId: emissionItemIds, inventoryId: 4 }),
                QueueUrl: queueUrl2,
                MessageGroupId: "INVENTORY_EXECUTE",
                MessageDeduplicationId: uuidv4(),
            };
            await extendedClient.sendMessage(params2);
            // await sqs.sendMessage(params2).promise();

            await mysql_con.commit();

            return getResponse({ message: 'success', userPoint: userCollectionPoint }, 200);
        }
        //Apply for card shipping
        else if (pattern == 2) {
            //Verify the shipping sms token first
            const now = Math.floor(new Date().getTime() / 1000);
            const user_data_sql = `SELECT * FROM User WHERE userId = ? AND userShippingSMSToken = ? AND userShippingSMSCheckExpiredAt >= ? LIMIT 0, 1`;
            const [user_data_result] = await mysql_con.query(user_data_sql, [userId, userShippingSMSToken, now]);

            //getUserPhoneAndCountryCode
            const user_data_sql1 = `SELECT userSMSTelNoFormat, userSMSTelLanguageCCValue, userShippingSMSCheckExpiredAt FROM User WHERE userId = ? LIMIT 0, 1`;
            const [user_data_result1] = await mysql_con.query(user_data_sql1, [userId]);
            let phoneNumber = user_data_result1[0].userSMSTelNoFormat;
            let userSMSTelLanguageCCValue = user_data_result1[0].userSMSTelLanguageCCValue;
            let userShippingSMSCheckExpiredAt = user_data_result1[0].userShippingSMSCheckExpiredAt;
            const user_sms_insert_sql = `INSERT UserSmsHistory SET userSmsHistoryOtp = ?, userSmsHistoryExpiredAt = ?, userSmsHistoryUserId = ?, userSmsHistoryTellNo = ?, userSmsHistoryTellCountryCode = ?, userSmsHistoryType = ?, userSmsHistoryStatus = ?, userSmsHistoryIPAddress = ?, userSmsHistoryCreatedAt = ?`;
            //Wrong otp provided or expired already
            if (Array.isArray(user_data_result) && user_data_result.length == 0) {
                //Create sms otp history for invalid
                await mysql_con.execute(user_sms_insert_sql, [userShippingSMSToken, userShippingSMSCheckExpiredAt, userId, phoneNumber, userSMSTelLanguageCCValue, 6, 2, sourceIP, now])
                throw new Error(403);
            }
            //Reset prev data if enter right otp
            else {
                const user_data_update_sql = `UPDATE User SET userShippingSMSToken = ?, userShippingSMSCheckExpiredAt = ? WHERE userId = ?`;
                await mysql_con.execute(user_data_update_sql, [null, null, userId]);
                //Create sms otp history for invalid
                await mysql_con.execute(user_sms_insert_sql, [userShippingSMSToken, userShippingSMSCheckExpiredAt, userId, phoneNumber, userSMSTelLanguageCCValue, 6, 1, sourceIP, now])
            }

            if (Array.isArray(userCollectionId) && userCollectionId.length == 0 || !Array.isArray(userCollectionId)) return getResponse({ message: 'No card selected!' }, 400);

            await mysql_con.beginTransaction();

            //Get matching records
            const user_collention_match_query = `
            SELECT *
            FROM UserCollection 
            JOIN Item ON UserCollection.userCollectionItemId = Item.itemId 
            WHERE userCollectionUserId = ? AND userCollectionStatus = ? AND userCollectionExpiredAt >= ? AND itemShippingFlag = ? AND userCollectionId IN (?)`;

            const [collection_match_result] = await mysql_con.query(user_collention_match_query, [userId, 1, now, 1, userCollectionId]);

            console.log("userCollectionId.length", userCollectionId.length);
            console.log("collection_match_result.length", collection_match_result.length);

            // A 501 error will occur if there is an inconsistency between the collection requested by the user and the available data in database.
            // Ex: Suppose UserA wants to make a shipment of his 3collections (CollectionA, CollectionB, CollectionC) 
            // 1. Request shipment from (CollectionA, CollectionB, CollectionC) 
            // 2. At this moment CollectionC's userCollectionExpiredAt has expired (Can be userCollectionStatus != 1 or itemShippingFlag != 1)
            // 3. In this case an inconsistency will occure, the number of requested collections != the number of available collections in DB 
            // 4. In this case 501 error will occure.
            if (userCollectionId.length > 0 && collection_match_result.length != userCollectionId.length) {
                console.log("unableShippingItemExists");
                throw new Error(501);
            }

            if (userCollectionId.length > 10) {
                console.log("shipping error一度の発送申請の上限は10枚です");
                throw new Error(502);
            }

            if (collection_match_result.length == 0) return getResponse({ message: 'No matching records found' }, 400);


            if (!userShippingId) return getResponse({ message: 'Wrong shippingId provided' }, 404);

            const userCollectionIds = collection_match_result.map(x => x.userCollectionId);
            const emissionItemIds = collection_match_result.map(x => x.userCollectionItemId);

            const redisKeyUserPoint = `user:${ENVID}:${userId}:pt`;
            const userPoint = await cluster.get(redisKeyUserPoint);

            const system_deposit_point_query = `SELECT systemValue from SystemData WHERE systemKey = ?`;
            const [system_deposit_point] = await mysql_con.query(system_deposit_point_query, ['systemShippingDepositPoint']);
            const { systemValue: systemShippingDepositPoint = 0 } = system_deposit_point[0] || {}

            if (system_deposit_point.length > 0 && Number(userPoint) >= Number(systemShippingDepositPoint)) {
                const user_shipping_query = `SELECT * FROM UserShipping WHERE userShippingUserId = ? AND userShippingId = ? LIMIT 0, 1`;
                const [user_shipping_result] = await mysql_con.query(user_shipping_query, [userId, userShippingId]);

                if (user_shipping_result.length == 0) return getResponse({ message: 'Wrong shippingId provided' }, 404);

                const {
                    userShippingName,
                    userShippingZipcode,
                    userShippingAddress,
                    userShippingAddress2,
                    userShippingAddress3,
                    userShippingAddress4,
                    userShippingTelCountryCode,
                    userShippingTel
                } = user_shipping_result[0] || {};

                const update_collection_status_query = `
                UPDATE UserCollection SET 
                userCollectionStatus = ?, 
                userCollectionTransactionUUID = UUID_TO_BIN(?), 
                userCollectionRequestAt = ?,
                userCollectionShippingName = ?,
                userCollectionShippingZipcode = ?,
                userCollectionShippingAddress = ?,
                userCollectionShippingAddress2 = ?,
                userCollectionShippingAddress3 = ?,
                userCollectionShippingAddress4 = ?,
                userCollectionShippingTelCountryCode = ?,
                userCollectionShippingTel = ?,
                userCollectionUpdatedAt = ?
                WHERE userCollectionId IN (?)`;

                const parameter = [
                    2,
                    uuidv4(),
                    now,
                    userShippingName,
                    userShippingZipcode,
                    userShippingAddress,
                    userShippingAddress2,
                    userShippingAddress3,
                    userShippingAddress4,
                    userShippingTelCountryCode,
                    userShippingTel,
                    now,
                    userCollectionIds,
                ];

                await mysql_con.query(update_collection_status_query, parameter);

                //Subtract shipping application points  
                const redisKeyUserPoint = `user:${ENVID}:${userId}:pt`;
                await cluster.decrby(redisKeyUserPoint, systemShippingDepositPoint);
                await cluster.set("shipping:" + ENVID + ":flag", "true");//set shipping True on redis for blinking
                //SQS Processing
                const params = {
                    MessageBody: JSON.stringify({ userId: userId, point: systemShippingDepositPoint, detailStatus: 8, executeAt: Math.floor(new Date().getTime() / 1000) }),
                    QueueUrl: queueUrl,
                    MessageGroupId: "COUPON_EXECUTE",
                    MessageDeduplicationId: uuidv4(),
                };
                await sqs.sendMessage(params).promise();
                console.log("Message published successfully");

                // 在庫変動をSQSに
                const params2 = {
                    MessageBody: JSON.stringify({ itemId: emissionItemIds, inventoryId: 5 }),
                    QueueUrl: queueUrl2,
                    MessageGroupId: "INVENTORY_EXECUTE",
                    MessageDeduplicationId: uuidv4(),
                };
                await extendedClient.sendMessage(params2);
                // await sqs.sendMessage(params2).promise();

                await mysql_con.commit();

                return getResponse({ message: 'success' }, 200);

            } else {
                console.log("Not enough points");
                throw new Error(201);
            }
        }

        return getResponse({ message: 'Wrong pattern passed!' }, 422);

    } catch (error) {
        console.error("error:", error)
        await mysql_con.rollback();

        // callback(error);
        console.log("errrrrrr", error);
        return getResponse({ errorCode: Number(error.message) }, 400);
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