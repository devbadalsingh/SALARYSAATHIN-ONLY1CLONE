import asyncHandler from "../middleware/asyncHandler.js";
import Lead from "../models/Leads.js";
import Application from "../models/Applications.js";
import Documents from "../models/Documents.js";
import Employee from "../models/Employees.js";
import { postLogs } from "./logs.js";
import { applicantDetails } from "./applicantPersonalDetails.js";
import sendEmail from "../utils/sendEmail.js";
import generateRandomNumber from "../utils/generateRandomNumbers.js";
import { otpSent } from "../utils/smsGateway.js";
import { otpVerified } from "../utils/smsGateway.js";
import equifax from "../utils/fetchCibil.js";
import { checkApproval } from "../utils/checkApproval.js";
import { postCamDetails } from "./application.js";
import cibilPdf from "../utils/cibilPdf.js";
import Otp from "../models/Otp.js";
import { nextSequence } from "../utils/nextSequence.js";
import LeadStatus from "../models/LeadStatus.js";

// @desc Create loan leads
// @route POST /api/leads
// @access Public
export const createLead = asyncHandler(async (req, res) => {
    const {
        fName,
        mName,
        lName,
        gender,
        dob,
        aadhaar,
        pan,
        mobile,
        alternateMobile,
        personalEmail,
        officeEmail,
        loanAmount,
        salary,
        pinCode,
        state,
        city,
        source,
    } = req.body;

    const name = fName.split(" ");

    let docs;
    const exisitingDoc = await Documents.findOne({ pan: pan });
    if (exisitingDoc) {
        docs = exisitingDoc;
    } else {
        docs = await Documents.create({
            pan: pan,
        });
    }
    const leadNo = await nextSequence("leadNo", "LD", 10);

    const leadStatus = await LeadStatus.create({
        pan: pan,
        leadNo,
        isInProcess: true,
    });

    console.log("lead No", leadNo);

    const newLead = await Lead.create({
        fName: name[0],
        mName: mName ? mName : name.length === 2 ? name[1] : "",
        lName: lName ?? "",
        gender,
        dob: new Date(dob),
        leadNo,
        aadhaar,
        pan,
        documents: docs._id.toString(),
        mobile: String(mobile),
        alternateMobile: alternateMobile ? String(alternateMobile) : "",
        personalEmail,
        officeEmail,
        loanAmount,
        salary,
        pinCode,
        state,
        city,
        source,
        leadStatus: leadStatus._id,
    });
    console.log("leadNo", newLead);

    if (!newLead) {
        res.status(400);
        throw new Error("Lead not created!!!");
    }

    // viewLeadsLog(req, res, status || '', borrower || '', leadRemarks = '');
    const logs = await postLogs(
        newLead._id,
        "NEW LEAD",
        `${newLead.fName}${newLead.mName && ` ${newLead.mName}`}${
            newLead.lName && ` ${newLead.lName}`
        }`,
        "New lead created"
    );
    return res.json({ newLead, logs });
});

// @desc Get all leads
// @route GET /api/leads
// @access Private
export const getAllLeads = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1; // current page
    const limit = parseInt(req.query.limit) || 10; // items per page
    const skip = (page - 1) * limit;

    const query = {
        $or: [{ screenerId: { $exists: false } }, { screenerId: null }],
        isRecommended: { $ne: true },
    };

    const leads = await Lead.find(query)
        .skip(skip)
        .limit(limit)
        .sort({ updatedAt: -1 });

    const totalLeads = await Lead.countDocuments(query);

    return res.json({
        totalLeads,
        totalPages: Math.ceil(totalLeads / limit),
        currentPage: page,
        leads,
    });
});

// @desc Get lead
// @route GET /api/leads/:id
// @access Private
export const getLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const lead = await Lead.findOne({ _id: id }).populate("documents");

    if (!lead) {
        res.status(404);
        throw new Error("Lead not found!!!!");
    }
    return res.json(lead);
});

// @desc Allocate new lead
// @route PATCH /api/leads/:id
// @access Private
export const allocateLead = asyncHandler(async (req, res) => {
    // Check if screener exists in the request
    const { id } = req.params;
    let screenerId;

    if (req.activeRole === "screener") {
        screenerId = req.employee._id.toString(); // Current user is a screener
    }

    const lead = await Lead.findByIdAndUpdate(
        id,
        { screenerId },
        { new: true }
    );

    if (!lead) {
        throw new Error("Lead not found"); // This error will be caught by the error handler
    }
    const employee = await Employee.findOne({ _id: screenerId });
    const logs = await postLogs(
        lead._id,
        "LEAD IN PROCESS",
        `${lead.fName} ${lead.mName ?? ""} ${lead.lName}`,
        `Lead allocated to ${employee.fName} ${employee.lName}`
    );

    // Send the updated lead as a JSON response
    return res.json({ lead, logs }); // This is a successful response
});

// @desc Get Allocated Leads depends on whether if it's admin or a screener.
// @route GET /api/leads/allocated
// @access Private
export const allocatedLeads = asyncHandler(async (req, res) => {
    let query;
    if (req.activeRole === "admin" || req.activeRole === "sanctionHead") {
        query = {
            screenerId: {
                $ne: null,
            },
            onHold: { $ne: true },
            isRejected: { $ne: true },
            isRecommended: { $ne: true },
            recommendedBy: null,
        };
    } else if (req.activeRole === "screener") {
        query = {
            screenerId: req.employee.id,
            onHold: { $ne: true },
            isRejected: { $ne: true },
            isRecommended: { $ne: true },
        };
    } else {
        res.status(401);
        throw new Error("Not authorized!!!");
    }
    const page = parseInt(req.query.page) || 1; // current page
    const limit = parseInt(req.query.limit) || 10; // items per page
    const skip = (page - 1) * limit;

    const leads = await Lead.find(query)
        .skip(skip)
        .limit(limit)
        .populate("screenerId")
        .populate("documents")
        .sort({ updatedAt: -1 });

    const totalLeads = await Lead.countDocuments(query);

    return res.json({
        totalLeads,
        totalPages: Math.ceil(totalLeads / limit),
        currentPage: page,
        leads,
    });
});

// @desc Update allocated lead's details
// @route PATCH /api/leads/update/:id
// @access Private
export const updateLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    if (!id) {
        res.status(400);
        throw new Error(
            "Id is required to fetch the lead from the collection!!"
        );
    }

    // Fetch the lead to check the screenerId
    const lead = await Lead.findById(id);

    if (!lead) {
        res.status(404);
        throw new Error("No lead found!!");
    }

    // Check if screenerId matches the one in the lead document
    if (lead.screenerId.toString() !== req.employee._id.toString()) {
        res.status(403);
        throw new Error("Unauthorized: You can not update this lead!!");
    }

    const updatedLead = await Lead.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
    );

    const employee = await Employee.findOne({
        _id: req.employee._id.toString(),
    });
    const logs = await postLogs(
        lead._id,
        "LEAD UPDATED",
        `${lead.fName}${lead.mName && ` ${lead.mName}`}${
            lead.lName && ` ${lead.lName}`
        }`,
        `Lead details updated by ${employee.fName} ${employee.lName}`
    );

    // Send the updated lead as a JSON response
    return res.json({ updatedLead, logs }); // This is a successful response
});

// @desc Recommend the lead
// @route Patch /api/lead/recommend/:id
// @access Private
export const recommendLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (req.activeRole === "screener") {
        // Find the lead by its ID
        const lead = await Lead.findById(id)
            .populate({
                path: "screenerId",
                select: "fName mName lName",
            })
            .populate("documents");

        if (!lead) {
            throw new Error("Lead not found"); // This error will be caught by the error handler
        }

        const status = await LeadStatus.findById({
            _id: lead.leadStatus.toString(),
        });

        if (!status) {
            res.status(404);
            throw new Error("Status not found");
        }

        const result = await checkApproval(
            lead,
            {},
            req.employee._id.toString(),
            ""
        );

        if (!result.approved) {
            res.status(400);
            throw new Error(`${result.message}`);
        }

        const screenerName = `${lead.screenerId.fName}${
            lead.screenerId.mName && ` ${lead.screenerId.mName}`
        } ${lead.screenerId.lName}`;

        const {
            pan,
            aadhaar,
            fName,
            mName,
            lName,
            gender,
            dob,
            mobile,
            alternateMobile,
            personalEmail,
            officeEmail,
        } = lead;
        const details = {
            pan,
            aadhaar,
            fName,
            mName,
            lName,
            gender,
            dob,
            mobile,
            alternateMobile,
            personalEmail,
            officeEmail,
            screenedBy: screenerName,
        };
        const applicant = await applicantDetails(details);

        await postCamDetails(id, lead.leadNo, lead.cibilScore, lead.loanAmount);

        const newApplication = new Application({
            leadNo: lead.leadNo,
            pan: lead.pan,
            lead: id,
            applicant: applicant._id,
        });
        const response = await newApplication.save();

        if (!response) {
            res.status(400);
            throw new Error("Could not recommend this lead!!");
        }

        // Change lead status to Application (showing the lead is in the application stage)
        status.stage = "Application";

        // Approve the lead by updating its status
        lead.isRecommended = true;
        lead.recommendedBy = req.employee._id;
        await lead.save();
        await status.save();

        const logs = await postLogs(
            lead._id,
            "LEAD APPROVED. TRANSFERED TO CREDIT MANAGER",
            `${lead.fName}${lead.mName && ` ${lead.mName}`}${
                lead.lName && ` ${lead.lName}`
            }`,
            `Lead approved by ${lead.screenerId.fName} ${lead.screenerId.lName}`
        );

        // Send the approved lead as a JSON response
        return res.json({ response, logs }); // This is a successful response
    } else {
        res.status(401);
        throw new Error("You are not authorized!!");
    }
});

// @desc verify email
// @route PATCH /api/verify/email/:id
// @access Private
export const emailVerify = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const lead = await Lead.findById(id);

    if (lead.screenerId.toString() !== req.employee._id.toString()) {
        res.status(401);
        throw new Error("You are not authorized!!");
    }

    if (lead.isEmailVerified) {
        res.json({ success: false, message: "Email is already verified!!" });
    }

    // const otp = generateRandomNumber();
    // const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // Calculate expiry time

    // lead.emailOtp = otp;
    // lead.emailOtpExpiredAt = otpExpiry;
    // await lead.save();

    if (!lead) {
        res.status(404);
        throw new Error("No lead found!!");
    }

    // Perform the email API request or other actions here
    // const response = await sendEmail(
    //     req.employee.email,
    //     lead.personalEmail,
    //     `${lead.fName} ${lead.mName} ${lead.lName}`,
    //     "Email Verfication",
    //     otp
    // );

    res.json({ success: true, message: "Email is now verified." });
});

// @desc Verify email OTP
// @route PATCH /api/verify/email-otp/:id
// @access Private
export const verifyEmailOtp = asyncHandler(async (req, res) => {
    // const { id } = req.params;
    // const { otp } = req.body;
    // const lead = await Lead.findById(id);
    // if (!lead) {
    //     res.status(404);
    //     throw new Error("Lead not found!!!");
    // }
    // if (lead.screenerId.toString() !== req.employee._id.toString()) {
    //     res.status(401);
    //     throw new Error("You are not authorized!!");
    // }
    // // Check if the OTP has expired
    // const currentTime = new Date();
    // if (currentTime > lead.emailOtpExpiredAt) {
    //     res.status(400);
    //     throw new Error("OTP has expired");
    // }
    // // Check if the OTP matches
    // if (lead.emailOtp !== otp) {
    //     res.status(400);
    //     throw new Error("Invalid OTP");
    // }
    // lead.isEmailVerified = true;
    // await lead.save();
    // res.json({
    //     success: true,
    //     message: "Email is now verified.",
    // });
});

// @desc Fetch CIBIL
// @route GET /api/verify/equifax/:id
// @access Private
export const fetchCibil = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const lead = await Lead.findById(id);
    const docs = await Documents.findById({ _id: lead.documents.toString() });

    // Replace all '/' with '-'
    // const normalizedDob = lead.dob.replace(/\//g, "-");

    if (!lead) {
        res.status(404);
        throw new Error("Lead not found!!!");
    }

    if (lead.screenerId.toString() !== req.employee._id.toString()) {
        res.status(404);
        throw new Error(
            "You are not authorized to fetch CIBIL for this lead!!!"
        );
    }

    if (!lead.cibilScore) {
        const response = await equifax(lead);
        const report = await cibilPdf(lead, docs);
        if (!report.success) {
            res.status(400);
            throw new Error(report.error);
        }
        const value =
            response?.CCRResponse?.CIRReportDataLst[0]?.CIRReportData
                ?.ScoreDetails[0]?.Value;

        if (!value) {
            return res.status(400).json({
                status: false,
                message: "CIBIL couldn't be fetched",
            });
        }
        lead.cibilScore = value;
        await lead.save();

        return res.json({ success: true, value: value });
    }
    return res.json({ success: true, value: lead.cibilScore });
});

// @desc Fetch CIBIL Report
// @route GET /api/verify/equifax-report/:id
// @access Private
export const cibilReport = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const lead = await Lead.findById(id);
    const docs = await Documents.findById({ _id: lead.documents.toString() });

    if (!lead) {
        res.status(404);
        throw new Error("Lead not found!!!");
    }

    if (lead.screenerId.toString() !== req.employee._id.toString()) {
        res.status(404);
        throw new Error(
            "You are not authorized to fetch CIBIL for this lead!!!"
        );
    }

    const report = await cibilPdf(lead, docs);
    // if (!report.success) {
    //     res.status(400);
    //     throw new Error(report.error);
    // }
    // return res.json({ success: true });

    return report;
});

// @desc API for mobile verification
// @route POST /api/verify/mobile/get-otp
// @access Public
export const mobileGetOtp = asyncHandler(async (req, res) => {
    const { fName, lName, mobile } = req.body;

    // Generate a new random OTP
    const otp = generateRandomNumber();

    // Send OTP via the OTP service
    const result = await otpSent(mobile, fName, lName, otp);

    if (result.data.ErrorMessage === "Success") {
        // Update or create the OTP record for the mobile number
        await Otp.findOneAndUpdate(
            { mobile }, // Search by mobile number
            { fName, lName, otp, createdAt: Date.now() }, // Update data
            { upsert: true, new: true } // Create a new record if not found
        );

        return res.json({ success: true, message: "OTP sent successfully!!" });
    }

    return res
        .status(500)
        .json({ success: false, message: "Failed to send OTP" });
});

/**
 * @desc    Verify OTP
 * @route   POST /api/verify/mobile/verify-otp
 * @access  Public
 */
export const verifyOtp = asyncHandler(async (req, res) => {
    const { mobile, otp } = req.body;

    // Check if both mobile and OTP are provided
    if (!mobile && !otp) {
        return res.status(400).json({
            success: false,
            message: "Mobile number and OTP are required.",
        });
    }

    // Find the OTP record in the database
    const otpRecord = await Otp.findOne({ mobile });

    // Check if the record exists
    if (!otpRecord) {
        return res.status(404).json({
            success: false,
            message:
                "No OTP found for this mobile number. Please request a new OTP.",
        });
    }

    // Verify if the provided OTP matches the stored OTP
    if (otpRecord.otp !== otp) {
        return res.status(401).json({
            success: false,
            message: "Invalid OTP. Please try again.",
        });
    }

    // OTP matches, verification successful
    return res.json({
        success: true,
        message: "OTP verified successfully!",
    });
});
