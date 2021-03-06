"use strict";
//sequencer
//coordinates all activate and each frame/step

//import DAT from 'dat-gui'
//Newer version of dat-gui fixes presets bug
import dat from './dat.gui.js' //copied to src dir for submission

const THREE = require('three'); // older modules are imported like this. You shouldn't have to worry about this much
import MusicalEvent from './musicalEvent.js'
import MusicAnalysis from './musicAnalysis.js'
import MidiIO from './midiIO.js'
import ExpressionTranslator from './expressionTranslator.js'
import {VXmanager} from "./VXmanager.js"
import {PowerCurve, PowerCurve3} from './powerCurve.js'
import {notePlayer} from './notePlayer.js'

export default class Sequencer{
    constructor( three_js_scene, camera, orbitControls ){
        //Store the THREE.js scene ref in case we need it, but mostly it'll
        // be used by VXmanager
        this.scene = three_js_scene;
        this.gui = {};
        this.camera = camera;
        this.orbitControls = orbitControls;

        this.midi = new MidiIO(); //sets up midi connection and inits first output device
        this.setDefaults();
        this.initGui(); //init GUI BEFORE framework
        this.initFramework();

        //simple note player
        this.notePlayer = new notePlayer( this.gui );

        //Last
        this.transportReset();

        //Test PowerCurve
        /*
        var pc = new PowerCurve( 1, 1 );
        pc.dump(10);
        gui.add(pc, 'a', 0.1, 10 ).name('P Curve a').onChange(function(newVal) {
            pc.a = newVal;
            pc.dump(20);
        })
        gui.add(pc, 'b', 0.1, 10 ).name('P Curve b').onChange(function(newVal) {
            pc.b = newVal;
            pc.dump(20);
        })
        */
    }

    setDefaults(){
        //musical paramaters
        this.musicParams = {
            meter: 4.0, //beats per measure - no denominator for now
            beatDur: 600, //beat duration in msec
            beatDurChange: 600, //Stores a new period for gui use
            beatDurChangeFlag: false, 
            
            //Num of divisions per quarter-note beat to quantize things to
            //12 - 16th notes and 16th triplets within a beat
            //4  - 16th notes only
            //3  - 8th note triplets only (e.g. for 6/8, choose this and meter =2 ??)
            //6  - 16th note triplets only (e.g. for 6/8 with off-beats)
            //TODO
            // Enable quantizing to 16th notes and 8th-note triplets, w/out 16-note triplets,
            // cuz 16-note triplets are too easy to get by accident, e.g. by playing ahead of
            // the beat
            quantizeDivs: 4,

            //Value used to round-up a beat value to call it the next beat if
            // we're doing beat-based stuff like metronome click. If current beat
            // value is within this value of next beat, call it as next beat.
            // Should help make a little less jitter on beat click and file/event
            // playback since we'll never be a full frame's duration late on doing
            // something that should be on the beat.
            beatFracCloseEnough: 0.02, //at 500msec period, 0.01 would be 5 msec


        }
        this.beatClick = {
            //Time of next beat click in performance beats
            nextPerfBeat: 0, 
            clickAccent: [ 0x99, 76, 110], //76 = hi wood block, 77 = low wood block
            clickRegular: [ 0x99, 77, 95 ],
            clickCountin: [ 0x99, 37, 120 ], //37 = side stick
        }

        this.log = {
            dumpNewME: false,
        }

        //For controlling maximum translator/visual update rate
        this.updatePrevMsec = 0;
        this.updateMinDelta = 25; //msec 

        this.guiFolders = {};
    }

    initGui(){
        console.log('init gui');
        //this.gui = new DAT.GUI();
        this.gui = new dat.GUI(); // for testing with dat.gui from github
        //this.gui.remember( this );
        this.gui.add(this.camera, 'fov', 0, 180).onChange(function(newVal) {
            this.updateProjectionMatrix();
            });
        this.guiStartStop = this.gui.add(this, 'startStopToggle').name('Start-Stop');

        //Use a special property here so we only change beatDur through the special function
        var beatDurGui = this.gui.add( this.musicParams, 'beatDurChange', 250, 2000 ).step(5).listen().name('beat period').onFinishChange( function(newVal){ 
                //this.sequencerRef.changeTempoOnTheFly( newVal );
                this.object.beatDurChangeFlag = true;
                //console.log('onChange');
            })
        //hack ref to this into this object so we can ref it from onFinishChange
        //It's working when use the slider, but soon as you click in the text box, it borks. I
        // guess there's a separate controller inside for the test box.
        beatDurGui.sequencerRef = this;

        this.guiFolders.log = this.gui.addFolder('Log / Debug');
        this.guiFolders.log.add(this.log, 'dumpNewME' ).name('New ME');
        this.guiFolders.log.add(this, 'dumpState').name('Dump State');
    }

    guiOpenClose(){
        //Do my own gui open/close cuz not working in latest version of dat.gui
        //I checked the keycode in eventhandler in dat.gui, and it's still 'h'.
        // Debugger doesn't get into dat.gui keyevent handler.
        if(this.gui.closed){
            this.gui.open()
        }
        else{
            this.gui.close();
        }
        this.VXmanager.guiOpenClose();
        this.translator.guiOpenClose();
    }

    initFramework(){
        //Instantiate the VXmanager
        this.VXmanager = new VXmanager( this.scene, this.camera, this.orbitControls );
        //this.VXmanager.initialize(); get called from VXmanager.reset()
        // so don't need to call it here as long as transportReset() gets
        // called when sequencer gets first instanatiated 

        //Instantiate the ExpressionTranslator
        this.translator = new ExpressionTranslator();
        this.musicAnalysis = new MusicAnalysis( this.musicParams, this.translator );
    }


    //Call this before starting from begin
    transportReset(){
        this.transportState = 'stop'; //others: 'play'
        this.beatClick.nextPerfBeat = 0;
        console.log('Transport stopped and reset');
        //reset/re-init some framework stuff to clear lists
        // of MX and VX objects (and whatever else)
        this.VXmanager.reset(); //Do this one FIRST so standalone VX's can be re-inited
        this.translator.reset();
        this.notePlayer.resetTransport();
    }

    ChangeTempoOnTheFly( newBeatDur ){
        //**NOTE this isn't fully working. hangs when slow down, jerks when speed up. why?
        // I tried the beatDurChangeFlag method to make sure the change happend just at begin
        // of frame update, but that didn't help.
        //console.log(" =================== new beatdur ", newBeatDur);
        
        //Ok to call this when stopped, cuz vals get reset in start()
        var msec = Date.now();
        this.musicParams.beatDur = newBeatDur;
        var times = this.getMusicTimes( msec );
        //Store where we are in the music
        this.tempoChangeBeatRaw = times.perfBeatRaw;
        //Store the msec time
        this.tempoChangeMsec = msec;
    }

    startStopToggle(){
        if( this.transportState == 'play' )
            this.stop();
        else
            this.start();
    }

    //Go!
    start(){
        this.startMsec = Date.now(); //abs world time we started the sequencer
        this.transportState = 'play'; //others: 'play'

        this.updatePrevMsec = this.startMsec - this.updateMinDelta; //so will do 1st frame right away
        this.updateCumDelta = 0;

        //Vars to allow on the fly tempo changess
        this.tempoChangeBeatRaw = 0;
        this.tempoChangeMsec = this.startMsec;

        //Do first frame right away, I guess
        this.nextFrame( this.startMsec );
        console.log("Sequencer started");
    }

    //Stop!
    //
    stop(){
        //Just stop and reset now. Worry about pause/resume later if it makes sense.
        this.transportReset();
    }

    //Process and render for next frame
    //Thread-safety - from what I've read, javascript is single-threaded with
    // some threading models in special cases, but nothing I'm doing, I think.
    nextFrame( globalMsec ){
        //console.log('nextFrame: ', globalMsec);
        if( this.transportState != 'play' )
            return;

        //Check for tempo change
        //Using a flag is a workaround attempt to see if it fixes the issue
        // of stutter/pause when changing tempo on the fly. It doesn't.
        if( this.musicParams.beatDurChangeFlag ){
            //console.log('caugt beatDurChangeFlag');
            this.musicParams.beatDurChangeFlag = false;
            this.ChangeTempoOnTheFly( this.musicParams.beatDurChange );
        }

        //Get current music time
        this.currentMusicTimes = this.getMusicTimes( globalMsec );

        //Simple note player or Beat click - can we do this in a separate thread somehow?
        var playClick = this.doNotePlayer( globalMsec ) == false;
        this.doBeatClick( playClick );

        //Only update visuals with a minimum time diff. This should help smooth things out
        // I think since we won't have as much load on the system.
        //This should help with things like particles that may be emitted every frame, cuz
        // will keep them more evenly spaced in time.
        //Music input and playback stuff gets done at every update above, cuz we want
        // less latency with that, and it takes less horsepower anyway.
        //** NOTE** make sure this doesn't cause trouble with MX updates that happen
        // in translator.updateForFrame()
        this.updateCumDelta += globalMsec - this.updatePrevMsec;
        if(  this.updateCumDelta >= this.updateMinDelta ){
            //Run through MX's & VX's and update - visualize!
            this.translator.updateForFrame( this.currentMusicTimes );
            this.updatePrevMsec = globalMsec;
            //Take away the min delta so if we keep getting in here on deltas just
            // under the threshold, the diff will accumlate and get us to trigger again
            // sooner.
            this.updateCumDelta -= this.updateMinDelta;
        }/*else 
            console.log('skip translator update with delta, and cumDelta ', globalMsec - this.updatePrevMsec, this.updateCumDelta)*/
    }

    dumpState(){
        this.VXmanager.dumpState();
        this.translator.dumpState();
    }

    doNotePlayer( globalMsec ){
        var times = this.currentMusicTimes;
        //Get the next wating note from the player. Notes will be quantized if they
        // were entered that way in the loop list.
        var done = false;
        while( ! done ){
            var note = this.notePlayer.checkNextNote();
            if( times.perfBeatRaw >= ( note[0] - this.musicParams.beatFracCloseEnough ) ){        
                //Tell the player we're using this note and it will update its state
                this.notePlayer.usedTheNote();
                //Check if we're way ahead of the note. This happens currently with buggy
                // tempo-change code I have.
                var skipNote = (times.perfBeatRaw - note[0]) > 0.5;
                //Send to midi output if player is enabled. We always go through the rest
                // of this so we can toggle back and forth with beat clicks
                if( this.notePlayer.isPlaying() && !skipNote ){
                    var midiNote = [ 0x99, note[1], 127];
                    this.midi.sendNote( midiNote, 0);
                    //Send to music analysis!
                    this.processNewME( new MusicalEvent( globalMsec, midiNote[1], 0x09, 0 ) );
                }
            }else
                done = true;
        }        
        return this.notePlayer.isPlaying();
    }

    //playNote - pass false to update click timing but note play any notes. This is so
    // we can stop notePlayer playback and jump right into having clicks.
    doBeatClick( playNote ){
        var times = this.currentMusicTimes;
        var note = [];
        if( times.perfBeatRaw >= ( this.beatClick.nextPerfBeat - this.musicParams.beatFracCloseEnough ) ){
            //Time to play the click

            if( playNote ){
                //Do one measure of countin
                if( times.measure == 0 ){
                    note = this.beatClick.clickCountin;
                }else{
                    if( times.beatNum == 0 ){
                        note = this.beatClick.clickAccent;
                    }else
                        note = this.beatClick.clickRegular;
                }
                this.midi.sendNote( note, 0 );
            }
            //update next click time
            this.beatClick.nextPerfBeat += 1.0;
        } 
    }

    //Process keyboard events
    keyboardInput(event){
      var globalMsec = Date.now();
      const keyName = event.key;
      //console.log('keydown: ', keyName );
      var isNote = true;
      var note = 0;
      var instr = 0;
      var duration = 0;
      //console.log('keyname'+ keyName +'.');
      switch( keyName ){
        case 'f':
            note = 35;  //35 is acoustic bass drum, 36 is bass drum 1
            instr = 0x09; //0-based midi channel for now
            duration = 0;
            break;
        case 'j':
            note = 38; //38 is acoustic snare
            instr = 0x09;
            duration = 0;
            break;
        case 'h':
            this.guiOpenClose();
            return;
        case 'p': //Was Space (comes through as an actual space char - go figure), but that causes trouble
                  // with entering values into gui.
            this.startStopToggle();
            return;
        default:
            isNote = false;
      }

      //Process the note
      if( isNote ){
          var noteOn = [ 0x90 + instr, note, 127 ];
          this.midi.sendNote( noteOn, duration );
          this.processNewME( new MusicalEvent( globalMsec, note, instr, duration ) );
      }
    }

    // For given abs msec time from sequencer start,
    // calc beat info and quantizes as appropriate.
    getMusicTimes( globalMsec ){
        //Event time in msec rel to sequencer start
        var perfMsec = globalMsec - this.startMsec;

        //Absolute fractional beat from start of sequencer
        //UN-quantized
        //var perfBeatRaw = perfMsec / this.musicParams.beatDur;
        var perfBeatRaw = this.tempoChangeBeatRaw + (globalMsec - this.tempoChangeMsec) / this.musicParams.beatDur;

        //Quantize
        //always doing it, for now at least
        //
        var perfDiv = Math.round( perfBeatRaw * this.musicParams.quantizeDivs );
        //Fractional beat time *from start of sequencer*
        //QUANTIZED
        var perfBeatQ =  perfDiv / this.musicParams.quantizeDivs;
        var measure = Math.floor(perfBeatQ / this.musicParams.meter);
        //integer beat number within the measure, 0-based like all other stuff
        var beatNum = Math.floor( perfBeatQ % this.musicParams.meter );
        //beat fraction within beat [0, (this.musicParams.quantizeDivs-1)/this.musicParams.quantizeDivs) ] 
        var beatFrac = perfBeatQ % 1.0; 
        
        //Beat division id, [0,11]
        //beatDiv is one of 12 id's of sub-beat
        //Always (?) 12 divs per quarter-note beat, regardless of quantization resolution
        //0 = downbeat
        //1 = first 16th triplet
        //2 = 2nd 16th triplet
        //3 = first 16th note
        //4 = first 8th triplet, 3rd 16th triplet
        //5 = 4th 16th triplet
        //6 = first 8th note, 2nd 16th note
        //...
        var beatDiv = Math.round( beatFrac * 12.0 );

        return {
            perfMsec: perfMsec,
            perfBeatRaw: perfBeatRaw, 
            perfBeatQ: perfBeatQ,
            measure: measure,
            beatNum: beatNum,
            beatFrac: beatFrac,
            beatDiv: beatDiv,
            musicParams: this.musicParams,
            beatToPerfMsec: this.beatToPerfMsec, //helper funcs
            perfMsecToBeat: this.perfMsecToBeat,
            }
    }

    //**NOTE** need to update these for changing tempo once that's working well
    beatToPerfMsec( beat ){
        return beat * this.musicParams.beatDur;
    }
    perfMsecToBeat( msec ){
        return msec / this.musicParams.beatDur;
    }

    //Process a musical note/event (ME) input
    //Then hands off to musical analysis
    processNewME( ME ){
        
        //Calc beat & measure time
        ME.setTimes( this.getMusicTimes( ME.globalMsec ) );
        //console.log('new ME: ', ME,' times: ', ME.times);

        if( this.log.dumpNewME ){
            //console.log('')
            //console.log('Sequencer: new MusicalEvent: ')
            console.log('Seq new ME: ', ME)
            console.log('  perfBeatQ: ', ME.times.perfBeatQ, ' msr: ', ME.times.measure, ' beat: ', ME.times.beatNum, ' beatDiv: ', ME.times.beatDiv );        
        }

        //Send to musical analysis.
        //ME gets added to list of notes in MA obj, and generates
        // a MX that gets added to list in MA obj
        this.musicAnalysis.processME( ME );

    }

}