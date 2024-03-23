/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const lambda = new AWS.Lambda();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const redis = require('ioredis');
const PAGES_VISITED = 0;
const ITEMS_PER_PAGE = 500;

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
        process.env.REGISTURL = dbinfo.REGISTURL
        process.env.MAILFROM = dbinfo.MAILFROM
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
    let mysql_con;
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
    let response;
    try {
        const {
            userShippingName,
            userShippingZipcode,
            userShippingAddress,
            userShippingAddress2,
            userShippingAddress3,
            userShippingAddress4,
            userShippingTel,
            userShippingTelCountryCode,
            userShippingTelCCValue,
            userShippingPriorityFlag = 0,
        } = JSON.parse(event.body);

        const result = await getUserId();
        const { success, userId, statusCode } = result || {};

        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);
        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);

        if (userShippingName != null && userShippingZipcode != null && userShippingAddress != null && userShippingTel != null) {
            //userShippingPriorityFlag is true that need remove prev 1 default selection
            if (userShippingPriorityFlag) {
                const userAddressUpdateSql = `Update UserShipping set userShippingPriorityFlag = ? WHERE userShippingUserId = ?`;
                const [userAddressData] = await mysql_con.query(userAddressUpdateSql, [0, userId]);
            }
            // createUserShipping
            const insertUserSql = `
                INSERT INTO UserShipping(
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
                    userShippingUserId,
                    userShippingCreatedAt,
                    userShippingUpdatedAt
                )
                VALUES(
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?
                );
            `;
            const createdAt = Math.floor(new Date().getTime() / 1000);
            let sql_param = [
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
                userId,
                createdAt,
                createdAt
            ];
            console.log("xxx4");
            const [query_reqult] = await mysql_con.execute(insertUserSql, sql_param);
            console.log('my response of insert addresss', response)
            //getUserAddress list
            const userAddressSql = `SELECT 
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
            FROM UserShipping WHERE userShippingUserId = ? ORDER BY userShippingCreatedAt`;
            const [userAddressData] = await mysql_con.query(userAddressSql, [userId]);
            console.log("userAddressData length", userAddressData.length);

            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify({
                    myShipping: userAddressData
                }),
            }
        }
        else {
            console.log('my response', response)
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify({
                    errorCode: 501,
                    message: "user address form validation error"
                }),
            }
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
                errorCode: 501,
                message: "user address create error"
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