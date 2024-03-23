/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');
const PAYPAY = require('@paypayopa/paypayopa-sdk-node');

process.env.TZ = "Asia/Tokyo";

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

const PRODUCTION_MODE = false;
const PAYPAY_PAYMENT_BASE_URL = PRODUCTION_MODE ? 'https://www.paypay.ne.jp/app/cashier' : 'https://stg-www.sandbox.paypay.ne.jp/app/cashier';

PAYPAY.Configure({
    clientId: 'a_54svo4016B_Ufq2', //API_KEY,
    clientSecret: '/qXrK52T3pqU1smKT5vVIdrEuhQgD0oJBD/twnCbEYk=', //API_SECRET,
    merchantId: '736248525743808512', //MERCHANT_ID,
    /* production_mode : Set the connection destination of the sandbox environment / production environment. 
    The default false setting connects to the sandbox environment. The True setting connects to the production environment. */
    productionMode: PRODUCTION_MODE,
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

    const ENVID = process.env.ENVID;

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
    let { paymentHistoryId, cpp, redirectUrl } = JSON.parse(event.body);

    let response = {};
    const userAgent = event.headers['User-Agent'];

    console.log('user agent >>>', userAgent)

    try {
        const result = await getUserId();
        const { success, userId, statusCode } = result || {};
        if (!success) return getResponse({ message: 'Unauthorize access' }, statusCode);

        // 購入商品の取得
        const redisPointData = await cluster.lrange("point:" + ENVID + ":list", 0, -1);
        const convertedObject = redisPointData.reduce((acc, item) => {
            const parsedItem = JSON.parse(item);
            acc[parsedItem.pointId] = parsedItem;
            return acc;
        }, {});

        const pointId = cpp;
        const { pointValue: amount = 0, pointPrice = 0 } = convertedObject[pointId] || {};

        console.log("cpp", cpp);
        console.log("amount", amount);


        let redirectPath = '';
        if (redirectUrl) {
            const url = new URL(redirectUrl);
            // Get the URL without query parameters
            redirectPath = url.origin + url.pathname;
        }

        console.log('final redirect url is >>>>', redirectPath);


        let payload = {
            merchantPaymentId: paymentHistoryId,
            amount: {
                amount: pointPrice,
                currency: "JPY"
            },
            codeType: "ORDER_QR",
            // orderDescription: "Mune's Favourite Cake",
            isAuthorization: false,
            redirectUrl: redirectPath + "?modalType=paypay&phi=" + paymentHistoryId,
            redirectType: "WEB_LINK",  //This can either be 'WEB_LINK' if the payment is happening on web browser or 'APP_DEEP_LINK' if the payment is happening on your app
            userAgent: userAgent, //"Mozilla/5.0 (iPhone; CPU iPhone OS 10_3 like Mac OS X) AppleWebKit/602.1.50 (KHTML, like Gecko) CriOS/56.0.2924.75 Mobile/14E5239e Safari/602.1"
        };
        // Calling the method to create a qr code
        let { BODY } = await PAYPAY.QRCodeCreate(payload);

        if (BODY?.data?.deeplink) {
            // Create a URL object
            const urlObject = new URL(BODY.data.deeplink);

            // Get the value of the 'link_key' parameter
            const linkKey = urlObject.searchParams.get('link_key');

            BODY.data.modifiedUrl = PAYPAY_PAYMENT_BASE_URL + '?code=' + linkKey
        }

        console.log('my checking >>>>>', BODY)

        return getResponse(BODY, 200);
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