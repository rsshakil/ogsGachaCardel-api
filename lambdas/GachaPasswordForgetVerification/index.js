/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
const AWS = require('aws-sdk')
const mysql = require("mysql2/promise");
const ssm = new AWS.SSM();
const bcrypt = require("bcryptjs");

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
    const writeDbConfig = {
        host: process.env.DBWRITEENDPOINT,
        user: process.env.DBUSER,
        password: process.env.DBPASSWORD,
        database: process.env.DBDATABSE,
        charset: process.env.DBCHARSET
    };

    let {
        token,
        newPassword1,
        newPassword2,
        registToken
    } = JSON.parse(event.body);

    let mysql_con;
    let response = {};

    const correntUnixTimestamp = Math.floor(new Date().getTime() / 1000 );
    const updatedAt = Math.floor(new Date().getTime() / 1000);
    try {
        // mysql connect
        mysql_con = await mysql.createConnection(writeDbConfig);

        // check & get target user info
        const read_sql = `SELECT userId, userForgetMailExpiredAt FROM User WHERE userForgetMailToken = ? AND userRegistToken = ? LIMIT 1`;
    
        const [read_query_result] = await mysql_con.execute(read_sql, [token, registToken]);
        if (read_query_result.length < 1) {
            // Not found user
            throw new Error(101);
        }
        const userInfo = read_query_result[0];

        if (userInfo.userForgetMailExpiredAt < correntUnixTimestamp) {
            // Token expired
            throw new Error(102);
        }
        if (newPassword1 !== newPassword2) {
            // New password not match
            throw new Error(103);
        }
        // パスワードチェック
        if(!newPassword1.match(/^([ -~]{6,32})+$/)) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                },
                body: JSON.stringify({
                    errorCode: 109,
                    message: "password regex error"
                }),
            }
        }

        const hashedPassword = await bcrypt.hashSync(newPassword1, 10);

        const update_sql = `
            UPDATE 
                User 
            SET 
                userRegistToken = ?,
                userForgetMailToken = ?,
                userForgetMailExpiredAt = ?,
                userPassword = ?,
                userUpdatedAt = ?
            WHERE 
                userId = ?`;
        const sql_param = [
            null,
            null,
            0,
            hashedPassword,
            updatedAt,
            userInfo.userId
        ];
        const [query_result] = await mysql_con.execute(update_sql, sql_param);

        response = {
            message: "success"
        };
        return getResponse(response, 200);
    } catch (error) {
        if (mysql_con) await mysql_con.rollback();
        console.error("error:", error)
        response = {
            errorCode: Number(error.message)
        }
        return getResponse(response, 400);
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