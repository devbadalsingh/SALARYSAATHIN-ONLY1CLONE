import asyncHandler from "../middleware/asyncHandler.js";
import Admin from "../models/Admin.js";
import CamDetails from "../models/CAM.js";
import Closed from "../models/Closed.js";
import Disbursal from "../models/Disbursal.js";
import { exportDisbursedData } from "../utils/dataChange.js";
import { postLogs } from "./logs.js";

// @desc Get new disbursal
// @route GET /api/disbursals/
// @access Private
export const getNewDisbursal = asyncHandler(async (req, res) => {
    if (
        req.activeRole === "disbursalManager" ||
        req.activeRole === "disbursalHead"
    ) {
        const page = parseInt(req.query.page); // current page
        const limit = parseInt(req.query.limit); // items per page
        const skip = (page - 1) * limit;

        const query = {
            disbursalManagerId: null,
            isRecommended: { $ne: true },
            isApproved: { $ne: true },
            sanctionESigned: { $eq: true },
        };

        const disbursals = await Disbursal.find(query)
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate({
                path: "sanction", // Populating the 'sanction' field in Disbursal
                populate: {
                    path: "application", // Inside 'sanction', populate the 'application' field
                    populate: {
                        path: "lead", // Inside 'application', populate the 'lead' field
                    },
                },
            });

        const totalDisbursals = await Disbursal.countDocuments(query);

        return res.json({
            totalDisbursals,
            totalPages: Math.ceil(totalDisbursals / limit),
            currentPage: page,
            disbursals,
        });
    }
});

// @desc Get Disbursal
// @route GET /api/disbursals/:id
// @access Private
export const getDisbursal = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const disbursal = await Disbursal.findOne({ _id: id })
        .populate([
            {
                path: "sanction", // Populating the 'sanction' field in Disbursal
                populate: [
                    { path: "recommendedBy", select: "fName mName lName" }, // Populate 'approvedBy' inside 'sanction'
                    { path: "approvedBy", select: "fName mName lName" },
                    {
                        path: "application", // Populate 'application' inside 'sanction'
                        populate: [
                            { path: "lead", populate: { path: "documents" } }, // Populate 'lead' inside 'application'
                            { path: "creditManagerId" }, // Populate 'creditManagerId' inside 'application'
                        ],
                    },
                ],
            },
        ])
        .populate("disbursedBy");

    if (!disbursal) {
        res.status(404);
        throw new Error("Disbursal not found!!!!");
    }

    // Convert disbursal to a plain object to make it mutable
    const disbursalObj = disbursal.toObject();

    // Fetch the CAM data and add to disbursalObj
    const cam = await CamDetails.findOne({
        leadId: disbursal?.sanction?.application.lead._id,
    });
    disbursalObj.sanction.application.cam = cam ? { ...cam.toObject() } : null;

    // Fetch banks from Admin model and add to disbursalObj
    const admin = await Admin.findOne();
    disbursalObj.disbursalBanks = admin ? admin.bank : [];

    return res.json({ disbursal: disbursalObj });
});

// @desc Allocate new disbursal
// @route PATCH /api/disbursals/:id
// @access Private
export const allocateDisbursal = asyncHandler(async (req, res) => {
    const { id } = req.params;
    let disbursalManagerId;

    if (req.activeRole === "disbursalManager") {
        disbursalManagerId = req.employee._id.toString();
    }

    const disbursal = await Disbursal.findByIdAndUpdate(
        id,
        { disbursalManagerId },
        { new: true }
    ).populate({
        path: "sanction", // Populating the 'sanction' field in Disbursal
        populate: [
            { path: "approvedBy" },
            {
                path: "application",
                populate: [
                    { path: "lead", populate: { path: "documents" } }, // Nested populate for lead and documents
                    { path: "recommendedBy" },
                ],
            },
        ],
    });

    if (!disbursal) {
        throw new Error("Application not found"); // This error will be caught by the error handler
    }

    const logs = await postLogs(
        disbursal?.sanction?.application.lead._id,
        "DISBURSAL IN PROCESS",
        `${disbursal?.sanction?.application.lead.fName}${
            disbursal?.sanction?.application.lead.mName &&
            ` ${disbursal?.sanction?.application.lead.mName}`
        } ${disbursal?.sanction?.application.lead.lName}`,
        `Disbursal application approved by ${req.employee.fName} ${req.employee.lName}`
    );

    // Send the updated lead as a JSON response
    return res.json({ disbursal, logs }); // This is a successful response
});

// @desc Get Allocated Disbursal depends on whether if it's admin or a Disbursal Manager.
// @route GET /api/disbursal/allocated
// @access Private
export const allocatedDisbursal = asyncHandler(async (req, res) => {
    let query;
    if (req.activeRole === "admin" || req.activeRole === "disbursalHead") {
        query = {
            disbursalManagerId: {
                $ne: null,
            },
            isRecommended: { $ne: true },
            isRejected: { $ne: true },
            onHold: { $ne: true },
            isApproved: { $ne: true },
        };
    } else if (req.activeRole === "disbursalManager") {
        query = {
            disbursalManagerId: req.employee.id,
            isRecommended: { $ne: true },
            isRejected: { $ne: true },
            onHold: { $ne: true },
        };
    } else {
        res.status(401);
        throw new Error("Not authorized!!!");
    }
    const page = parseInt(req.query.page); // current page
    const limit = parseInt(req.query.limit); // items per page
    const skip = (page - 1) * limit;
    const disbursals = await Disbursal.find(query)
        .skip(skip)
        .limit(limit)
        .populate({
            path: "sanction", // Populating the 'sanction' field in Disbursal
            populate: [
                { path: "approvedBy" },
                {
                    path: "application",
                    populate: [
                        { path: "lead", populate: { path: "documents" } }, // Nested populate for lead and documents
                        { path: "creditManagerId" }, // Populate creditManagerId
                        { path: "recommendedBy" },
                    ],
                },
            ],
        })
        .populate({
            path: "disbursalManagerId",
            select: "fName mName lName",
        })
        .sort({ updatedAt: -1 });

    const totalDisbursals = await Disbursal.countDocuments(query);

    return res.json({
        totalDisbursals,
        totalPages: Math.ceil(totalDisbursals / limit),
        currentPage: page,
        disbursals,
    });
});

// @desc Recommend a disbursal application
// @route PATCH /api/disbursals/recommend/:id
// @access Private
export const recommendDisbursal = asyncHandler(async (req, res) => {
    if (req.activeRole === "disbursalManager") {
        const { id } = req.params;
        const { remarks } = req.body;

        // Find the application by its ID
        const disbursal = await Disbursal.findById(id)
            .populate({
                path: "sanction", // Populating the 'sanction' field in Disbursal
                populate: [
                    { path: "approvedBy" },
                    {
                        path: "application",
                        populate: [
                            { path: "lead", populate: { path: "documents" } }, // Nested populate for lead and documents
                            { path: "creditManagerId" }, // Populate creditManagerId
                            { path: "recommendedBy" },
                        ],
                    },
                ],
            })
            .populate({
                path: "disbursalManagerId",
                select: "fName mName lName",
            });

        disbursal.isRecommended = true;
        disbursal.recommendedBy = req.employee._id.toString();
        await disbursal.save();

        const logs = await postLogs(
            disbursal.sanction.application.lead._id,
            "DISBURSAL APPLICATION RECOMMENDED. SENDING TO DISBURSAL HEAD",
            `${disbursal.sanction.application.lead.fName}${
                disbursal.sanction.application.lead.mName &&
                ` ${disbursal.sanction.application.lead.mName}`
            } ${disbursal.sanction.application.lead.lName}`,
            `Disbursal approved by ${req.employee.fName} ${req.employee.lName}`,
            `${remarks}`
        );

        return res.json({ success: true, logs });
    }
});

// @desc Get all the pending disbursal applications
// @route GET /api/disbursals/pending
// @access Private
export const disbursalPending = asyncHandler(async (req, res) => {
    if (
        req.activeRole === "disbursalManager" ||
        req.activeRole === "disbursalHead" ||
        req.activeRole === "admin"
    ) {
        const page = parseInt(req.query.page); // current page
        const limit = parseInt(req.query.limit); // items per page
        const skip = (page - 1) * limit;

        const query = {
            disbursalManagerId: { $ne: null },
            isRecommended: { $eq: true },
            onHold: { $ne: true },
            isRejected: { $ne: true },
            isDisbursed: { $ne: true },
        };

        const disbursals = await Disbursal.find(query)
            .skip(skip)
            .limit(limit)
            .populate({
                path: "sanction", // Populating the 'sanction' field in Disbursal
                populate: [
                    { path: "approvedBy" },
                    {
                        path: "application",
                        populate: [
                            { path: "lead", populate: { path: "documents" } }, // Nested populate for lead and documents
                            { path: "creditManagerId" }, // Populate creditManagerId
                            { path: "recommendedBy" },
                        ],
                    },
                ],
            })
            .populate("disbursalManagerId");

        const totalDisbursals = await Disbursal.countDocuments(query);

        return res.json({
            totalDisbursals,
            totalPages: Math.ceil(totalDisbursals / limit),
            currentPage: page,
            disbursals,
        });
    } else {
        res.status(401);
        throw new Error("You are not authorized to check this data");
    }
});

// @desc Adding details after the payment is made
// @route PATCH /api/disbursals/approve/:id
// @access Private
export const approveDisbursal = asyncHandler(async (req, res) => {
    if (req.activeRole === "disbursalHead") {
        const { id } = req.params;

        const {
            payableAccount,
            paymentMode,
            amount,
            channel,
            disbursalDate,
            remarks,
        } = req.body;

        const disbursalData = await Disbursal.findById(id).populate({
            path: "sanction",
            populate: { path: "application" },
        });
        const cam = await CamDetails.findOne({
            leadId: disbursalData?.sanction?.application?.lead.toString(),
        });
        // if()
        let currentDisbursalDate = new Date(disbursalDate);
        let camDisbursalDate = new Date(cam.details.disbursalDate);
        let camRepaymentDate = new Date(cam.details.repaymentDate);
        if (
            camDisbursalDate.toLocaleDateString() !==
            currentDisbursalDate.toLocaleDateString()
        ) {
            const tenure = Math.ceil(
                (camRepaymentDate.getTime() - currentDisbursalDate.getTime()) /
                    (1000 * 3600 * 24)
            );
            const repaymentAmount =
                Number(cam.details.loanRecommended) +
                (Number(cam.details.loanRecommended) *
                    Number(tenure) *
                    Number(cam.details.roi)) /
                    100;
            const update = await CamDetails.findByIdAndUpdate(
                cam._id,
                {
                    "details.eligibleTenure": tenure,
                    "details.disbursalDate": currentDisbursalDate,
                    "details.repaymentAmount": repaymentAmount,
                },
                { new: true }
            );
        }

        const disbursal = await Disbursal.findByIdAndUpdate(
            id,
            {
                payableAccount,
                paymentMode,
                amount,
                channel,
                disbursedAt: disbursalDate,
                utr: remarks,
                isDisbursed: true,
                disbursedBy: req.employee._id.toString(),
            },
            { new: true }
        ).populate({
            path: "sanction",
            populate: [
                { path: "approvedBy" },
                {
                    path: "application",
                    populate: [
                        { path: "lead", populate: { path: "documents" } }, // Nested populate for lead and documents
                        { path: "recommendedBy" },
                    ],
                },
            ],
        });
        await Closed.updateOne(
            { "data.loanNo": disbursalData.loanNo },
            {
                $set: {
                    "data.$.isDisbursed": true,
                },
            }
        );

        const logs = await postLogs(
            disbursal.sanction.application.lead._id,
            "DISBURSAL APPLICATION APPROVED. SENDING TO DISBURSAL HEAD",
            `${disbursal.sanction.application.lead.fName}${
                disbursal.sanction.application.lead.mName &&
                ` ${disbursal.sanction.application.lead.mName}`
            } ${disbursal.sanction.application.lead.lName}`,
            `Application approved by ${req.employee.fName} ${req.employee.lName}`,
            `${remarks}`
        );

        res.json({ success: true, logs });
    }
});

// @desc Get all the disbursed applications
// @route GET /api/disbursals/disbursed
// @access Private
export const disbursed = asyncHandler(async (req, res) => {
    if (req.activeRole === "disbursalHead" || req.activeRole === "admin") {
        const page = parseInt(req.query.page); // current page
        const limit = parseInt(req.query.limit); // items per page
        const skip = (page - 1) * limit;

        const query = {
            disbursalManagerId: { $ne: null },
            isDisbursed: { $eq: true },
        };

        const disbursals = await Disbursal.aggregate([
            { $match: query },
            {
                $project: {
                    loanNo: 1,
                    leadNo: 1,
                    sanction: 1,
                    disbursedBy: 1,
                    updatedAt: 1,
                },
            }, // Direct projection, no need for $arrayElemAt

            // Lookup Lead
            {
                $lookup: {
                    from: "leads",
                    localField: "leadNo",
                    foreignField: "leadNo",
                    as: "lead",
                    pipeline: [
                        {
                            $project: {
                                _id: 1,
                                fName: 1,
                                mName: 1,
                                lName: 1,
                                pan: 1,
                                aadhaar: 1,
                                mobile: 1,
                                city: 1,
                                state: 1,
                                source: 1,
                            },
                        },
                    ],
                },
            },
            {
                $set: {
                    lead: {
                        $arrayElemAt: ["$lead", 0],
                    },
                },
            },

            // Lookup CAM Details
            {
                $lookup: {
                    from: "camdetails",
                    localField: "lead._id", // Correctly resolved lead ID
                    foreignField: "leadId",
                    as: "camDetails",
                    pipeline: [
                        {
                            $project: {
                                _id: 0,
                                loanRecommended: "$details.loanRecommended",
                                actualNetSalary: "$details.actualNetSalary",
                            },
                        },
                    ],
                },
            },
            {
                $set: {
                    camDetails: { $arrayElemAt: ["$camDetails", 0] },
                },
            },

            // Lookup DisbursedBy (Employee who processed the disbursal)
            {
                $lookup: {
                    from: "employees",
                    localField: "disbursedBy",
                    foreignField: "_id",
                    as: "disbursedBy",
                    pipeline: [{ $project: { fName: 1, lName: 1 } }],
                },
            },
            { $set: { disbursedBy: { $arrayElemAt: ["$disbursedBy", 0] } } },

            { $sort: { updatedAt: -1 } },
            // Final Projection
            {
                $project: {
                    updatedAt: 1,
                    "lead.fName": 1,
                    "lead.mName": 1,
                    "lead.lName": 1,
                    "lead.pan": 1,
                    "lead.mobile": 1,
                    leadNo: 1,
                    loanNo: 1,
                    "lead.aadhaar": 1,
                    "lead.city": 1,
                    "lead.state": 1,
                    "camDetails.actualNetSalary": 1,
                    "camDetails.loanRecommended": 1,
                    "lead.source": 1,
                    "disbursedBy.fName": 1,
                    "disbursedBy.lName": 1,
                },
            },
        ]);

        const totalDisbursals = await Disbursal.countDocuments(query);

        return res.json({
            totalDisbursals,
            totalPages: Math.ceil(totalDisbursals / limit),
            currentPage: page,
            disbursals,
        });
    } else {
        res.status(401);
        throw new Error("You are not authorized to check this data");
    }
});

// @desc Get report of all disbursed applications
// @route GET /api/disbursals/disbursed/report
// @access Private
export const disbursedReport = asyncHandler(async (req, res) => {
    const data = await exportDisbursedData();
    return res.json({ data });
});
