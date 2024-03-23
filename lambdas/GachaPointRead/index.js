/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
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

    let mysql_con;
    let response = {};

    try {
        const redisPointData = await cluster.lrange("point:" + ENVID + ":list", 0, -1);
        console.log("redisPointData",redisPointData)
        const convertedObject = redisPointData.reduce((acc, item) => {
            const { pointId, pointName, pointValue, pointPrice, pointType, pointOrder, pointCreditStripeFlag,
                pointCreditEpsilonFlag,
                pointBankStripeFlag,
                pointBankEpsilonFlag,
                pointBankManualFlag,
                pointPaypayEpsilonFlag,
                pointPaypayFlag,
                pointConvenienceStoreFlag,
                pointEMoneyFlag } = JSON.parse(item);
                console.log("pointOrder",pointOrder);
            acc[pointId] = {
                pointId,
                userChargeUUID: pointId,
                userChargePointPattern: pointId,
                userChargeName: pointName,
                userChargePoint: pointValue,
                userChargePrice: pointPrice,
                userPointOrder: pointOrder,
                hasCardStripe:pointCreditStripeFlag==1?true:false,
                hasCardEpsilon:pointCreditEpsilonFlag==1?true:false,
                hasBankStripe:pointBankStripeFlag==1?true:false,
                hasBankEpsilon:pointBankEpsilonFlag==1?true:false,
                hasBankManual:pointBankManualFlag==1?true:false,
                hasPaypayEpsilon:pointPaypayEpsilonFlag==1?true:false,
                hasPointPaypay:pointPaypayFlag==1?true:false,
                hasConvenienceStore:pointConvenienceStoreFlag==1?true:false,
                hasEMoney:pointEMoneyFlag==1?true:false,
            };
            return acc;
        }, {});
        console.log("convertedObject",convertedObject);
        response = {
            message: "success",
            records: convertedObject
        };
        return getResponse(response, 200);
    } catch (error) {
        console.error("error:", error)
        return getResponse(error, 400);
    } finally {
        await cluster.disconnect();
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