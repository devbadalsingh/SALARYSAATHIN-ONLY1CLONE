import mongoose from "mongoose";

const leadSchema = new mongoose.Schema(
    {
        fName: {
            type: String,
            required: true,
            trim: true,
        },
        mName: {
            type: String,
            trim: true,
        },
        lName: {
            type: String,
            trim: true,
        },
        gender: {
            type: String,
            required: true,
            enum: ["M", "F", "O"],
        },
        dob: {
            type: Date,
            required: true,
        },
        leadNo: {
            type: String,
            required: true,
            unique: true,
            sparse: true,
        },
        aadhaar: {
            type: String,
            required: true,
            // unique: true,
        },
        pan: {
            type: String,
            required: true,
            // unique: true,
        },
        cibilScore: {
            type: String,
        },
        mobile: {
            type: String,
            required: true,
        },
        alternateMobile: {
            type: String,
        },
        personalEmail: {
            type: String,
            required: true,
        },
        officeEmail: {
            type: String,
            required: true,
        },
        loanAmount: {
            type: Number,
            required: true,
        },
        salary: {
            type: Number,
            required: true,
        },
        pinCode: {
            type: Number,
            required: true,
        },
        state: {
            type: String,
            required: true,
        },
        city: {
            type: String,
            required: true,
        },
        screenerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
        },
        onHold: {
            type: Boolean,
            default: false,
        },
        heldBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
        },
        leadStatus: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "LeadStatus",
        },
        isMobileVerified: {
            type: Boolean,
            default: false,
        },
        emailOtp: Number,
        emailOtpExpiredAt: { type: Date },
        isAadhaarVerified: { type: Boolean, default: false },
        isAadhaarDetailsSaved: { type: Boolean, default: false },
        isPanVerified: { type: Boolean, default: false },
        isEmailVerified: {
            type: Boolean,
            default: false,
        },
        isRejected: {
            type: Boolean,
            default: false,
        },
        isRejectedBySystem: {
            type: Boolean,
            default: false,
        },
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
        },
        documents: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Document",
        },

        stage: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "LeadStatus",
        },
        isRecommended: {
            type: Boolean,
            default: false,
        },
        recommendedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
        },
        source: {
            type: String,
            required: true,
            enum: ["website", "bulk", "landingPage", "whatsapp", "app"],
            default: "website",
        },
        referenceId: {
            type: String,
        },
    },
    { timestamps: true }
);

const Lead = mongoose.model("Lead", leadSchema);
export default Lead;
