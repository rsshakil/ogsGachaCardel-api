/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');

/**
 * ManagerAppRead.
 * 
 * @param {*} event 
 * @returns {json} response
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
    }

    // Database info
    const readDbConfig = {
        host: process.env.DBREADENDPOINT,
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

    let mysql_con;
    let response = {};

    try {
        // mysql connect
        mysql_con = await mysql.createConnection(readDbConfig);

        const { pathParameters = null, queryStringParameters } = event || {};

        const { gachaId = 0 } = pathParameters || {};
        const { pageNumber, l } = queryStringParameters || {};  //l=language code

        console.log('gachaId', gachaId);
        console.log('pageNumber', pageNumber);

        if (!gachaId || !pageNumber || !l) return getResponse({ message: "Invalid parameter provided" }, 507);

        const translateId = await cluster.get(`language:${ENVID}:${l}`);
        console.log('translateId', translateId);

        const remainingCount = Number(await cluster.llen("gacha:" + ENVID + ":" + gachaId + ":list"));

        if (remainingCount == 0) {

            const data_sql = `
            SELECT 
                gachaHistoryId, 
                gachaHistoryData 
            FROM GachaHistory 
            WHERE gachaHistoryGachaId = ? AND gachaHistoryPageNumber = ? AND gachaHistoryTranslateId = ?`;
            console.log('data_sql', data_sql);
            console.log('placeholder value gachaId', gachaId);
            console.log('placeholder value pageNumber', pageNumber);
            console.log('placeholder value translateId', translateId);
            const [query_result_data] = await mysql_con.query(data_sql, [gachaId, pageNumber, translateId]);
            console.log('query_result_data', query_result_data);

            const last_page_data_sql = `SELECT MAX(gachaHistoryPageNumber) AS lastPageNo FROM GachaHistory WHERE gachaHistoryGachaId = ? AND gachaHistoryTranslateId = ?`
            console.log('last_page_data_sql', last_page_data_sql);
            const [last_page_data_result] = await mysql_con.query(last_page_data_sql, [gachaId, translateId]);
            console.log('last_page_data_result', last_page_data_result);

            let hasNextPage = true;
            let hasPrevPage = false;

            if (pageNumber >= last_page_data_result[0].lastPageNo) {
                hasNextPage = false;
            }

            if (pageNumber > 1 && pageNumber <= last_page_data_result[0].lastPageNo) {
                hasPrevPage = true;
            }

            let historyRecords = [];
            if (query_result_data.length > 0) {
                historyRecords = query_result_data[0].gachaHistoryData;
            }
            console.log('historyRecords', historyRecords);

            response = { records: historyRecords, hasNextPage, hasPrevPage }

            return getResponse(response, 200);
        }
        else {
            return getResponse([], 200);
        }

    } catch (error) {
        console.error(error);
        return getResponse(error, 400);
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