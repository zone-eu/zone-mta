'use strict';

module.exports = function(grunt) {
    // Project configuration.
    grunt.initConfig({
        eslint: {
            all: ['lib/**/*.js', 'test/**/*.js', 'config/**/*.js', 'Gruntfile.js', 'app.js']
        }
    });

    // Load the plugin(s)
    grunt.loadNpmTasks('grunt-eslint');

    // Tasks
    grunt.registerTask('default', ['eslint']);
};
