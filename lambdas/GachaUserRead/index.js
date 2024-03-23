/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');

const PAGES_VISITED = 0;
const ITEMS_PER_PAGE = 1000;

const jwt = require('jsonwebtoken');
const { skip } = require('node:test');
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
 * 
 * ユーザーのあらゆる情報を返却する
 * コレクションデータ
 * 発送中データ
 * 未発送データ
 * お届け先データ
 */
exports.handler = async (event) => {
    console.log("Event data:", event);
    console.log("event.Authorization", event.headers.Authorization);
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
    let writeDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET,
    };
    const redisConfig = [
        { host: process.env.REDISPOINT1, port: 6379 },
        { host: process.env.REDISPOINT2, port: 6379 }
    ];
    let mysql_con;
    const cluster = new redis.Cluster(
        redisConfig,
        {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: { tls: true }
        }
    );

    try {
        const { queryStringParameters = null, pathParameters = null } = event || {};
        const { skip, take, l, pp } = queryStringParameters || {};
        console.log("langauge", l);
        // ログインしている必要あり
        if (event.headers.Authorization && event.headers.Authorization != null && event.headers.Authorization != "Bearer null") {
            console.log("user data exists!");
            // トークン
            const token = jwtPattern.exec(event.headers.Authorization)[1];
            console.log("token", token);
            // JWT解析
            const decoded = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
            if (decoded == null) {
                console.error("JWTが解析できない");
                throw new Error(103);
            }
            else {
                let decodeData = decoded;
                let userId = decodeData.userId;
                mysql_con = await mysql.createConnection(writeDbConfig);
                // ポイントデータ
                if (pp) {
                    // ポイントが更新されていない場合ループする（最大3秒）
                    let nowPoint;
                    for (let i = 0; i < 10; i++) {
                        nowPoint = await cluster.get("user:" + ENVID + ":" + userId + ":pt");
                        if (nowPoint != pp) {
                            break;
                        }
                        else {
                            await sleep(300);
                        }
                    }
                    return {
                        statusCode: 200,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': '*',
                        },
                        body: JSON.stringify({
                            userPointStart: parseInt(pp, 10),
                            userPointEnd: parseInt(nowPoint, 10)
                        })
                    }
                }
                // 全てのデータ
                else {
                    let offset = (skip === undefined) ? PAGES_VISITED : skip;
                    let limit = (take === undefined) ? ITEMS_PER_PAGE : take;
                    let hasMore = false;

                    // 日本語ID
                    const languageCode = l ? l : await cluster.get("language:" + ENVID + ":default");
                    const translateJaId = await cluster.get("language:" + ENVID + ":ja");
                    const translateDefaultId = await cluster.get("language:" + ENVID + ":" + languageCode);
                    const translateId = await cluster.get("language:" + ENVID + ":" + l);

                    // コレクションデータ
                    const collectionSql = `SELECT userCollectionId, userCollectionItemId AS itemId, userCollectionPoint, userCollectionEmissionId, userCollectionExpiredAt FROM UserCollection WHERE userCollectionUserId = ? AND userCollectionStatus = 1 ORDER BY userCollectionCreatedAt LIMIT ?, ?`;
                    console.log("userId", userId);
                    console.log("offset", offset);
                    console.log("limit", limit);
                    let collectionParameter = [];
                    collectionParameter.push(userId);
                    collectionParameter.push(Number(offset));
                    collectionParameter.push(Number(limit) + 1);  //Get extra 1 record to identify is there more records present or not
                    let [collectionData] = await mysql_con.query(collectionSql, collectionParameter);
                    console.log("data length", collectionData.length);

                    //Identify is there more records available or not
                    if (collectionData.length > limit) {
                        hasMore = true;
                        collectionData = collectionData.slice(0, -1); //Now remove the extra record
                    }

                    let collectionResponseData = [];
                    for (let i = 0; i < collectionData.length; i++) {
                        let itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + collectionData[i].itemId + ":" + translateId + ":info"));
                        if (!itemData) {
                            itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + collectionData[i].itemId + ":" + translateDefaultId + ":info"));
                            if (!itemData) {
                                itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + collectionData[i].itemId + ":" + translateJaId + ":info"));
                            }
                        }
                        if (itemData) {
                            itemData.userCollectionId = collectionData[i].userCollectionId;
                            itemData.itemPoint = collectionData[i].userCollectionPoint;
                            itemData.isItemSelected = false;
                            itemData.emissionId = collectionData[i].userCollectionEmissionId;
                            itemData.shippingRequestDeadline = collectionData[i].userCollectionExpiredAt * 1000
                            collectionResponseData.push(itemData);
                        }
                    }

                    let userAddressData = [];
                    let applyingResponseData = [];
                    let shippingResponseData = [];
                    let userData = [];

                    //For the 1st time load
                    if (take === undefined) {
                        // 発送申請中情報 2 = 発送申請　5 = 発送対応中
                        const applyingSql = `SELECT userCollectionItemId AS itemId, userCollectionPoint, userCollectionEmissionId, userCollectionRequestAt FROM UserCollection WHERE userCollectionUserId = ? AND (userCollectionStatus = 2 OR userCollectionStatus = 5)  ORDER BY userCollectionCreatedAt LIMIT ?, ?`;
                        console.log("userId", userId);
                        console.log("offset", offset);
                        console.log("limit", limit);
                        let applyingParameter = [];
                        applyingParameter.push(userId);
                        applyingParameter.push(offset);
                        applyingParameter.push(limit);
                        const [applyingData] = await mysql_con.query(applyingSql, applyingParameter);
                        console.log("applyingResponseData length", applyingData.length);

                        for (let i = 0; i < applyingData.length; i++) {
                            console.log("redisKey applyingResponseData", "item:" + ENVID + ":" + applyingData[i].itemId + ":" + translateId + ":info");
                            let itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + applyingData[i].itemId + ":" + translateId + ":info"));
                            console.log("redisItemData", itemData);
                            if (!itemData) {
                                itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + applyingData[i].itemId + ":" + translateDefaultId + ":info"));
                                if (!itemData) {
                                    itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + applyingData[i].itemId + ":" + translateJaId + ":info"));
                                }
                            }
                            if (itemData) {
                                itemData.itemPoint = applyingData[i].userCollectionPoint;
                                itemData.isItemSelected = false;
                                itemData.emissionId = applyingData[i].userCollectionEmissionId;
                                itemData.shippingRequestDeadline = applyingData[i].userCollectionRequestAt * 1000
                                applyingResponseData.push(itemData);
                            }
                        }
                        // 発送済み情報 3 = 発送済み
                        const shippingSql = `SELECT userCollectionItemId AS itemId, userCollectionPoint, userCollectionEmissionId, userCollectionShippedAt FROM UserCollection WHERE userCollectionUserId = ? AND userCollectionStatus = 3  ORDER BY userCollectionCreatedAt LIMIT ?, ?`;
                        console.log("userId", userId);
                        console.log("offset", offset);
                        console.log("limit", limit);
                        let shippingParameter = [];
                        shippingParameter.push(userId);
                        shippingParameter.push(offset);
                        shippingParameter.push(limit);
                        const [shippingData] = await mysql_con.query(shippingSql, shippingParameter);
                        console.log("shippingResponseData length", shippingData.length);

                        for (let i = 0; i < shippingData.length; i++) {
                            console.log("redis shippingResponseData", "item:" + ENVID + ":" + shippingData[i].itemId + ":" + translateId + ":info");
                            let itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + shippingData[i].itemId + ":" + translateId + ":info"));
                            console.log("redisItemData", itemData);
                            if (!itemData) {
                                itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + shippingData[i].itemId + ":" + translateDefaultId + ":info"));
                                if (!itemData) {
                                    itemData = JSON.parse(await cluster.get("item:" + ENVID + ":" + shippingData[i].itemId + ":" + translateJaId + ":info"));
                                }
                            }
                            if (itemData) {
                                itemData.itemPoint = shippingData[i].userCollectionPoint;
                                itemData.isItemSelected = false;
                                itemData.emissionId = shippingData[i].userCollectionEmissionId;
                                itemData.shippingRequestDeadline = shippingData[i].userCollectionShippedAt * 1000
                                shippingResponseData.push(itemData);
                            }
                        }
                        // プレゼント情報
                        // お届け先情報
                        const userAddressSql = `
                        SELECT 
                            userShippingId,
                            userShippingName,
                            userShippingZipcode,
                            userShippingAddress,
                            userShippingAddress2,
                            userShippingAddress3,
                            userShippingAddress4,
                            userShippingTel,
                            userShippingTelCountryCode,
                            userShippingTelCCValue,
                            userShippingPriorityFlag,
                            CASE WHEN userShippingPriorityFlag=1 THEN true ELSE false END AS isItemSelected,
                            userShippingMemo
                        FROM UserShipping 
                        WHERE userShippingUserId = ? 
                        ORDER BY userShippingCreatedAt`;
                        [userAddressData] = await mysql_con.query(userAddressSql, [userId]);
                        console.log("userAddressData length", userAddressData.length);

                        // ユーザー情報
                        const userSql = `SELECT userEmail,userSMSFlag,userCountryId FROM User WHERE userId = ? LIMIT 1`;
                        [userData] = await mysql_con.query(userSql, [userId]);
                        console.log("userData length", userData.length);
                        userData[0].userId = userId;
                    }

                    return {
                        statusCode: 200,
                        headers: {
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Headers': '*',
                        },
                        body: JSON.stringify({
                            myCollection: collectionResponseData,
                            hasMore,
                            myApplying: applyingResponseData,
                            myShipping: shippingResponseData,
                            myShippingAddress: userAddressData,
                            user: userData[0]
                        }),
                    }
                }
            }
        }
        // ログインしていない
        else {
            console.error("ログインしていない");
            throw new Error(101);
        }
    } catch (error) {
        console.error(error);
        console.error("error1:", error.message);
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            },
            body: JSON.stringify({
                errorCode: Number(error.message)
            }),
        }
    } finally {
        try {
            cluster.disconnect();
        }
        catch (e) {
            console.log("finally error", e);
        }
        if (mysql_con) await mysql_con.close();
    }
};

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
