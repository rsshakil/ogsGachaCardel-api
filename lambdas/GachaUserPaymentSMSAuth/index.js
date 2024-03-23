/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const redis = require('ioredis');

const jwt = require('jsonwebtoken')
const jwtPattern = /^Bearer[ ]+([^ ]+)[ ]*$/i;

/**
 * GachaUserPaymentSMSAuth.
 * 
 * 購入前SMS認証コードのチェック
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

    const redisConfig = [
        { host: process.env.REDISPOINT1, port: 6379 },
        { host: process.env.REDISPOINT2, port: 6379 }
    ];

    let { userPaymentSMSToken } = JSON.parse(event.body);
    const now = Math.floor(new Date().getTime() / 1000);

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

        //Point conversion process
		//Verify the shipping sms token first
		const now = Math.floor(new Date().getTime() / 1000);
		const user_data_sql = `SELECT * FROM User WHERE userId = ? AND userPaymentSMSToken = ? AND userPaymentSMSCheckExpiredAt >= ? LIMIT 0, 1`;
		const [user_data_result] = await mysql_con.query(user_data_sql, [userId, userPaymentSMSToken, now]);

        //getUserPhoneAndCountryCode
        const user_data_sql1 = `SELECT userSMSTelNoFormat, userSMSTelLanguageCCValue, userPaymentSMSCheckExpiredAt FROM User WHERE userId = ? LIMIT 0, 1`;
        const [user_data_result1] = await mysql_con.query(user_data_sql1, [userId]);
        let phoneNumber = user_data_result1[0].userSMSTelNoFormat;
        let userSMSTelLanguageCCValue = user_data_result1[0].userSMSTelLanguageCCValue;
        let userPaymentSMSCheckExpiredAt = user_data_result1[0].userPaymentSMSCheckExpiredAt;

        const user_sms_insert_sql = `INSERT UserSmsHistory SET userSmsHistoryOtp = ?, userSmsHistoryExpiredAt = ?, userSmsHistoryUserId = ?, userSmsHistoryTellNo = ?, userSmsHistoryTellCountryCode = ?, userSmsHistoryType = ?, userSmsHistoryStatus = ?, userSmsHistoryIPAddress = ?, userSmsHistoryCreatedAt = ?`;

		//Wrong otp provided or expired already
		if (Array.isArray(user_data_result) && user_data_result.length == 0) {
            await mysql_con.execute(user_sms_insert_sql, [userPaymentSMSToken, userPaymentSMSCheckExpiredAt, userId, phoneNumber, userSMSTelLanguageCCValue, 5, 2, sourceIP, now]);
			throw new Error(403);
		}
		//Reset prev data if enter right otp
		else {
			// 認証に通った場合、関連カラムを空にする
			const user_data_update_sql = `UPDATE User SET userPaymentSMSToken = ?, userPaymentSMSCheckExpiredAt = ? WHERE userId = ?`;
			await mysql_con.execute(user_data_update_sql, [null, null, userId]);

            await mysql_con.execute(user_sms_insert_sql, [userPaymentSMSToken, userPaymentSMSCheckExpiredAt, userId, phoneNumber, userSMSTelLanguageCCValue, 5, 1, sourceIP, now]);
		}
		return getResponse({ message: 'success' }, 200);
    } catch (error) {
        console.error("error:", error)
        await mysql_con.rollback();

        // callback(error);
        console.log("errrrrrr", error);
        return getResponse({ errorCode: Number(error.message) }, 400);
    } finally {
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