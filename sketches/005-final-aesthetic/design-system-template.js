// Momo Architecture - Final Aesthetic
// Will be populated with design principles extracted from 5 reference images

const designSystem = {
    // Layout Strategy
    layout: {
        type: '', // hierarchical, radial, force-directed, layered
        clustering: '', // how nodes are grouped
        spacing: {}, // vertical/horizontal spacing rules
        alignment: '' // node alignment strategy
    },
    
    // Color Palette
    colors: {
        background: '', // main background
        backgroundGradient: '', // gradient if used
        nodes: {
            primary: '', // main nodes
            secondary: '', // supporting nodes
            accent: '', // highlight nodes
            data: '' // storage nodes
        },
        edges: {
            primary: '', // main connections
            secondary: '', // utility connections
            data: '' // persistence connections
        },
        text: {
            primary: '',
            secondary: '',
            labels: ''
        },
        glows: [] // array of glow colors/effects
    },
    
    // Node Styling
    nodes: {
        shapes: [], // rectangle, rounded-rect, circle, etc.
        borderRadius: '', // corner rounding
        borderStyle: '', // solid, gradient, glow
        borderWidth: {},
        fills: '', // solid, gradient, glassmorphism
        shadows: [], // drop-shadow, box-shadow details
        padding: {},
        glassmorphism: {} // backdrop-blur, opacity settings
    },
    
    // Edge Routing
    edges: {
        curveType: '', // bezier, straight, organic
        thickness: {}, // different weights
        arrows: '', // arrow styling
        animation: [], // pulse, flow, dash animation
        gradients: false // whether edges use gradients
    },
    
    // Typography
    typography: {
        fontFamily: '',
        sizes: {},
        weights: {},
        letterSpacing: '',
        lineHeight: ''
    },
    
    // Visual Hierarchy
    hierarchy: {
        hubEmphasis: [], // techniques for emphasizing important nodes
        layering: '', // z-index strategy
        scaleVariation: {} // size differences
    },
    
    // Unique Elements
    unique: []
};

// Will synthesize from all 5 image analyses
export default designSystem;
