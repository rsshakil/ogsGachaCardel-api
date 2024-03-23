/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const PAYPAY = require('@paypayopa/paypayopa-sdk-node');

process.env.TZ = "Asia/Tokyo";

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;
const sqs = new AWS.SQS();

PAYPAY.Configure({
    clientId: 'a_54svo4016B_Ufq2', //API_KEY,
    clientSecret: '/qXrK52T3pqU1smKT5vVIdrEuhQgD0oJBD/twnCbEYk=', //API_SECRET,
    merchantId: '736248525743808512', //MERCHANT_ID,
    /* production_mode : Set the connection destination of the sandbox environment / production environment. 
    The default false setting connects to the sandbox environment. The True setting connects to the production environment. */
    productionMode: false,
});

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
    process.env.ACCESS_TOKEN_SECRET = dbinfo.ACCESS_TOKEN_SECRET;
    // }

    // Database info
    const readDbConfig = {
        host: process.env.DBREADENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };

    let mysql_con;
    let response = {};

    try {
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};
        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        const { paymentHistoryId } = event.pathParameters || {};
        console.log("paymentHistoryId", paymentHistoryId);

        if (!paymentHistoryId) return getResponse({ message: "Invalid paymentHistoryId provided" }, 404);


        // Calling the method to get payment details
        // const paymentDetails = await PAYPAY.GetCodePaymentDetails([paymentHistoryId]);

        // console.log('my check >>', paymentDetails)


        mysql_con = await mysql.createConnection(readDbConfig);

        const sql_data = `SELECT userPaymentHistoryId, userPaymentHistoryStatus, userPaymentHistoryPaymentPoint FROM UserPaymentHistory WHERE userPaymentHistoryUserId = ? AND userPaymentHistoryId = ? LIMIT 0, 1`;
        const [resultData] = await mysql_con.query(sql_data, [userId, paymentHistoryId]);

        response.records = resultData[0];

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